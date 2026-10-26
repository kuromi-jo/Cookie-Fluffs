/**
 * @file change-phone-service.js
 * @description Verified Change Phone: atomically consumes a VERIFIED verification challenge and
 * updates users.phone in one transaction. If the challenge is not verified/owned/target-matched,
 * or the update fails, nothing changes. Records a sanitized security event and an essential
 * in-app security notification. Never trusts a client number without server normalization.
 */
import { pool } from './db.js';
import { normalizePhone } from './validation.js';
import { insertNotification } from './notification-service.js';

async function securityEvent(client, userId, eventType, reason) {
  await client.query(
    `INSERT INTO account_security_events (user_id, event_type, details)
     VALUES ($1, $2, jsonb_build_object('reason', $3::text))`,
    [userId, eventType, reason],
  );
}

/**
 * Applies a verified phone change.
 * @param {object} deps.verification - the verification service (provides consumeVerified).
 */
export async function changeCustomerPhone(
  userId,
  { challengeId, newPhone },
  { databasePool = pool, verification, now = new Date() } = {},
) {
  if (!databasePool) throw Object.assign(new Error('Account changes are temporarily unavailable.'), { status: 503 });
  if (!verification) throw new Error('Verification service is required.');
  const normalized = normalizePhone(newPhone);
  if (!normalized) return { kind: 'invalid_phone' };
  if (typeof challengeId !== 'string' || !challengeId) return { kind: 'unverified' };

  const client = await databasePool.connect();
  try {
    await client.query('BEGIN');
    // Lock the customer row for the whole change.
    const userResult = await client.query(
      'SELECT * FROM users WHERE id = $1 FOR UPDATE',
      [userId],
    );
    const user = userResult.rows[0];
    if (!user || user.account_status !== 'active') {
      await client.query('ROLLBACK');
      return { kind: 'unauthorized' };
    }

    // Atomically consume the VERIFIED authorization bound to this user + operation + new phone.
    // A mere issued (unverified) challenge, a wrong target/operation/owner, an expired or already
    // consumed challenge all return false here, so the change cannot proceed.
    const consumed = await verification.consumeVerified(client, {
      userId,
      challengeId,
      operation: 'change_phone',
      target: normalized,
    });
    if (!consumed) {
      await client.query('ROLLBACK');
      return { kind: 'unverified' };
    }

    const updated = await client.query(
      'UPDATE users SET phone = $2 WHERE id = $1 RETURNING *',
      [userId, normalized],
    );
    await securityEvent(client, userId, 'phone_change_succeeded', 'verified_change');
    // Essential in-app security notification (always delivered regardless of order prefs).
    await insertNotification(client, {
      userId,
      eventType: 'security_alert',
      title: 'Mobile number updated',
      body: 'Your Cookie Fluffs mobile number was changed. If this wasn\u2019t you, contact support.',
      linkPath: '/profile/security',
      dedupeKey: `phone_changed:${challengeId}`,
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
