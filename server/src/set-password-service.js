/**
 * @file set-password-service.js
 * @description Secure Set Password for Google-only customers (Phase 5). In ONE transaction it
 * validates and consumes BOTH a mandatory Google reauthentication proof (operation set_password)
 * and a verified set_password email OTP proof, confirms the account currently has NO password,
 * stores a bcrypt hash, rotates auth_version (invalidating other sessions), and records a
 * sanitized security event plus the essential notification. If any check fails, the password
 * write and both proof consumptions roll back together. A current session alone is never
 * sufficient. Never logs or returns plaintext passwords.
 */
import bcrypt from 'bcryptjs';
import { pool } from './db.js';
import { validatePassword } from './validation.js';
import { insertNotification } from './notification-service.js';

const BCRYPT_COST = 10; // matches signup / change-password / recovery

async function securityEvent(client, userId, eventType, reason) {
  await client.query(
    `INSERT INTO account_security_events (user_id, event_type, details)
     VALUES ($1, $2, jsonb_build_object('reason', $3::text))`,
    [userId, eventType, reason],
  );
}

/**
 * Sets a first password for a Google-only account.
 * @param {object} deps.verification - verification service (consumeVerified).
 * @param {object} deps.reauth - reauth service (consumeReauth).
 */
export async function setCustomerPassword(
  userId,
  { reauthId, challengeId, newPassword },
  { databasePool = pool, verification, reauth, now = new Date() } = {},
) {
  if (!databasePool) throw Object.assign(new Error('Account changes are temporarily unavailable.'), { status: 503 });
  if (!verification || !reauth) throw new Error('Verification and reauth services are required.');

  if (typeof reauthId !== 'string' || !reauthId) return { kind: 'unauthorized' };
  if (typeof challengeId !== 'string' || !challengeId) return { kind: 'unverified' };
  if (typeof newPassword !== 'string' || !newPassword || newPassword.length > 128) {
    return { kind: 'invalid_password', message: 'Choose a password with 8 to 64 characters.' };
  }

  const client = await databasePool.connect();
  try {
    await client.query('BEGIN');
    const userResult = await client.query('SELECT * FROM users WHERE id = $1 FOR UPDATE', [userId]);
    const user = userResult.rows[0];
    if (!user || user.account_status !== 'active') {
      await client.query('ROLLBACK');
      return { kind: 'unauthorized' };
    }

    // Set-only: never overwrite an existing password through this path (that is Change Password).
    if (user.password_hash) {
      await client.query('ROLLBACK');
      return { kind: 'password_exists' };
    }

    // Validate the new password against the shared policy (identity-aware, common-password checks).
    const passwordError = validatePassword(newPassword, {
      email: user.email,
      firstName: user.first_name,
      lastName: user.last_name,
    });
    if (passwordError) {
      await client.query('ROLLBACK');
      return { kind: 'invalid_password', message: passwordError };
    }

    // 1) Consume the mandatory reauth proof, bound to this user + set_password + current auth_version.
    const reauthOk = await reauth.consumeReauth(client, {
      userId,
      proofId: reauthId,
      operation: 'set_password',
      authVersion: Number(user.auth_version),
    });
    if (!reauthOk) {
      await client.query('ROLLBACK');
      return { kind: 'unauthorized' };
    }

    // 2) Consume the verified set_password email OTP (ownership of the registered email).
    const consumed = await verification.consumeVerified(client, {
      userId,
      challengeId,
      operation: 'set_password',
    });
    if (!consumed) {
      await client.query('ROLLBACK');
      return { kind: 'unverified' };
    }

    const passwordHash = await bcrypt.hash(newPassword, BCRYPT_COST);
    const updated = await client.query(
      `UPDATE users
       SET password_hash = $2, auth_version = auth_version + 1, password_changed_at = $3
       WHERE id = $1
       RETURNING *`,
      [userId, passwordHash, now],
    );

    // Reuse the existing event vocabulary with a distinct reason (no migration needed).
    await securityEvent(client, userId, 'password_change_succeeded', 'set_password');
    await insertNotification(client, {
      userId,
      eventType: 'password_changed',
      title: 'Password set',
      body: 'You can now log in with your email and password as well as Google. '
        + 'Other devices were signed out. If this wasn\u2019t you, contact support.',
      linkPath: '/profile/security',
      dedupeKey: `password_set:${updated.rows[0].auth_version}`,
    });
    await client.query('COMMIT');
    return { kind: 'set', user: updated.rows[0] };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
