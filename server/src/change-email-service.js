/**
 * @file change-email-service.js
 * @description Verified Change Email: in ONE transaction it validates and consumes BOTH a
 * mandatory reauthentication proof and a verified new-email ownership challenge, checks the new
 * address is unique, updates users.email, rotates auth_version (invalidating other sessions), and
 * records a sanitized security event plus an essential in-app notification. If any check fails,
 * the account update and both proof consumptions roll back together. Never trusts a client
 * number/flag; the new email is normalized and validated server-side. Google subject IDs are
 * never modified here.
 */
import { pool } from './db.js';
import { validateEmail } from './validation.js';
import { insertNotification } from './notification-service.js';

function normalizeEmail(value) {
  return String(value ?? '').trim().toLowerCase();
}

async function securityEvent(client, userId, eventType, reason) {
  await client.query(
    `INSERT INTO account_security_events (user_id, event_type, details)
     VALUES ($1, $2, jsonb_build_object('reason', $3::text))`,
    [userId, eventType, reason],
  );
}

/**
 * Applies a reauthenticated, ownership-verified email change.
 * @param {object} deps.verification - verification service (consumeVerified).
 * @param {object} deps.reauth - reauth service (consumeReauth).
 */
export async function changeCustomerEmail(
  userId,
  { reauthId, challengeId, newEmail },
  { databasePool = pool, verification, reauth, now = new Date() } = {},
) {
  if (!databasePool) throw Object.assign(new Error('Account changes are temporarily unavailable.'), { status: 503 });
  if (!verification || !reauth) throw new Error('Verification and reauth services are required.');

  const normalized = normalizeEmail(newEmail);
  if (validateEmail(normalized)) return { kind: 'invalid_email' };
  if (typeof reauthId !== 'string' || !reauthId) return { kind: 'unauthorized' };
  if (typeof challengeId !== 'string' || !challengeId) return { kind: 'unverified' };

  const client = await databasePool.connect();
  try {
    await client.query('BEGIN');
    const userResult = await client.query(
      'SELECT * FROM users WHERE id = $1 FOR UPDATE',
      [userId],
    );
    const user = userResult.rows[0];
    if (!user || user.account_status !== 'active') {
      await client.query('ROLLBACK');
      return { kind: 'unauthorized' };
    }

    // Reject a no-op change to the current address (case-insensitive).
    if (normalizeEmail(user.email) === normalized) {
      await client.query('ROLLBACK');
      return { kind: 'duplicate_email' };
    }

    // 1) Consume the mandatory reauthentication proof, bound to this user + operation + the
    //    account's current auth_version. A password change since issuance revokes it.
    const reauthOk = await reauth.consumeReauth(client, {
      userId,
      proofId: reauthId,
      operation: 'change_email',
      authVersion: Number(user.auth_version),
    });
    if (!reauthOk) {
      await client.query('ROLLBACK');
      return { kind: 'unauthorized' };
    }

    // 2) Consume the verified new-email ownership challenge (bound to user + operation + target).
    const consumed = await verification.consumeVerified(client, {
      userId,
      challengeId,
      operation: 'change_email',
      target: normalized,
    });
    if (!consumed) {
      await client.query('ROLLBACK');
      return { kind: 'unverified' };
    }

    // 3) Uniqueness under the row lock (authoritative; also catches a concurrent race via 23505).
    const taken = await client.query('SELECT 1 FROM users WHERE email = $1 AND id <> $2', [normalized, userId]);
    if (taken.rowCount) {
      await client.query('ROLLBACK');
      return { kind: 'duplicate_email' };
    }

    let updated;
    try {
      updated = await client.query(
        'UPDATE users SET email = $2, auth_version = auth_version + 1 WHERE id = $1 RETURNING *',
        [userId, normalized],
      );
    } catch (error) {
      if (error.code === '23505') { // unique_violation: another account claimed it concurrently
        await client.query('ROLLBACK');
        return { kind: 'duplicate_email' };
      }
      throw error;
    }

    await securityEvent(client, userId, 'email_change_succeeded', 'verified_change');
    await insertNotification(client, {
      userId,
      eventType: 'security_alert',
      title: 'Email address updated',
      body: 'Your Cookie Fluffs email was changed, and other devices were signed out. '
        + 'You\u2019ll use the new email to log in. If this wasn\u2019t you, contact support.',
      linkPath: '/profile/security',
      dedupeKey: `email_changed:${updated.rows[0].auth_version}`,
    });
    await client.query('COMMIT');
    return { kind: 'changed', user: updated.rows[0] };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
