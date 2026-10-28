/**
 * @file account-security-service.js
 * @description Atomic password changes with durable throttling and sanitized audit records.
 */
import bcrypt from 'bcryptjs';
import { pool } from './db.js';
import { validatePassword } from './validation.js';
import { insertNotification } from './notification-service.js';

const RATE_ACTION = 'change_password';
const RATE_WINDOW_MINUTES = 15;
const RATE_LIMIT = 5;

function retryAfterSeconds(oldestAttempt, now) {
  const expiresAt = new Date(oldestAttempt).getTime() + RATE_WINDOW_MINUTES * 60_000;
  return Math.max(1, Math.min(RATE_WINDOW_MINUTES * 60, Math.ceil((expiresAt - now.getTime()) / 1000)));
}

async function recordEvent(client, userId, eventType, reason) {
  await client.query(
    `INSERT INTO account_security_events (user_id, event_type, details)
     VALUES ($1, $2, jsonb_build_object('reason', $3::text))`,
    [userId, eventType, reason],
  );
}

/**
 * Changes one active customer's password while serializing attempts on their user row.
 * Requires a VERIFIED `change_password` email-code challenge (`challengeId`), consumed in the same
 * transaction as the change. A wrong current/new password leaves the challenge unconsumed, so the
 * customer can correct the password without requesting a new code.
 */
export async function changeCustomerPassword(
  userId,
  currentPassword,
  newPassword,
  { databasePool = pool, verification, challengeId, now = new Date() } = {},
) {
  if (!databasePool) throw Object.assign(new Error('Account security is temporarily unavailable.'), { status: 503 });
  if (!verification) throw new Error('Verification service is required.');
  if (typeof challengeId !== 'string' || !challengeId) return { kind: 'unverified' };
  const client = await databasePool.connect();
  try {
    await client.query('BEGIN');
    const userResult = await client.query(
      `SELECT id, first_name, last_name, full_name, email, phone, avatar, password_hash,
              auth_version, account_status, created_at
       FROM users WHERE id = $1 FOR UPDATE`,
      [userId],
    );
    const user = userResult.rows[0];
    if (!user || user.account_status !== 'active') {
      await client.query('ROLLBACK');
      return { kind: 'unauthorized' };
    }

    if (!user.password_hash) {
      await client.query('ROLLBACK');
      return { kind: 'password_unavailable' };
    }

    await client.query(
      `DELETE FROM auth_rate_limits
       WHERE user_id = $1 AND action = $2
         AND occurred_at <= $3::timestamptz - interval '${RATE_WINDOW_MINUTES} minutes'`,
      [userId, RATE_ACTION, now],
    );
    const rateResult = await client.query(
      `SELECT occurred_at FROM auth_rate_limits
       WHERE user_id = $1 AND action = $2
         AND occurred_at > $3::timestamptz - interval '${RATE_WINDOW_MINUTES} minutes'
       ORDER BY occurred_at ASC
       FOR UPDATE`,
      [userId, RATE_ACTION, now],
    );
    if (rateResult.rowCount >= RATE_LIMIT) {
      await recordEvent(client, userId, 'password_change_throttled', 'rate_limit');
      await client.query('COMMIT');
      return { kind: 'throttled', retryAfter: retryAfterSeconds(rateResult.rows[0].occurred_at, now) };
    }

    const currentMatches = await bcrypt.compare(currentPassword, user.password_hash);
    if (!currentMatches) {
      await client.query(
        'INSERT INTO auth_rate_limits (user_id, action, occurred_at) VALUES ($1, $2, $3)',
        [userId, RATE_ACTION, now],
      );
      await recordEvent(client, userId, 'password_change_failed', 'incorrect_current_password');
      await client.query('COMMIT');
      return { kind: 'invalid_current' };
    }

    const passwordError = validatePassword(newPassword, {
      email: user.email,
      firstName: user.first_name,
      lastName: user.last_name,
    });
    if (passwordError) {
      await recordEvent(client, userId, 'password_change_failed', 'invalid_new_password');
      await client.query('COMMIT');
      return { kind: 'invalid_new', message: passwordError };
    }
    if (await bcrypt.compare(newPassword, user.password_hash)) {
      await recordEvent(client, userId, 'password_change_failed', 'password_reuse');
      await client.query('COMMIT');
      return { kind: 'reused' };
    }

    // Email-code proof, bound to this customer and consumed only together with the change.
    const consumed = await verification.consumeVerified(client, { userId, challengeId, operation: 'change_password' });
    if (!consumed) {
      await client.query('ROLLBACK');
      return { kind: 'unverified' };
    }

    const passwordHash = await bcrypt.hash(newPassword, 10);
    const updatedResult = await client.query(
      `UPDATE users
       SET password_hash = $2,
           auth_version = auth_version + 1,
           password_changed_at = $3
       WHERE id = $1
       RETURNING *`,
      [userId, passwordHash, now],
    );
    await client.query('DELETE FROM auth_rate_limits WHERE user_id = $1 AND action = $2', [userId, RATE_ACTION]);
    await recordEvent(client, userId, 'password_change_succeeded', 'customer_change');
    // Essential security notification, deduped on the new auth_version (unique per change).
    await insertNotification(client, {
      userId,
      eventType: 'password_changed',
      title: 'Password changed',
      body: 'Your password was changed. Other signed-in devices were signed out.',
      linkPath: '/profile/security',
      dedupeKey: `password_changed:${updatedResult.rows[0].auth_version}`,
    });
    await client.query('COMMIT');
    return { kind: 'changed', user: updatedResult.rows[0] };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export const passwordChangeRateLimit = Object.freeze({ attempts: RATE_LIMIT, windowMinutes: RATE_WINDOW_MINUTES });
