/**
 * @file password-recovery-service.js
 * @description Enumeration-resistant, single-use password recovery by emailed 6-digit code.
 * The code is stored only as a keyed hash bound to the account, expires after 30 minutes, is
 * invalidated after 5 wrong attempts, and any new request cancels older codes.
 */
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { pool } from './db.js';
import { passwordRecoveryConfig } from './runtime-config.js';
import { validatePassword } from './validation.js';
import { createBrevoEmailAdapter } from './recovery-email.js';

const TOKEN_TTL_MINUTES = 30;
const RATE_WINDOW_MINUTES = 60;
const EMAIL_RATE_LIMIT = 3;
const IP_RATE_LIMIT = 10;
const TOKEN_FAILURE_LIMIT = 5;

export const RECOVERY_GENERIC_MESSAGE = 'If an account matches that email, we sent it a 6-digit code.';
export const RECOVERY_INVALID_MESSAGE = 'That code is incorrect or has expired. Check your latest email or request a new code.';

function keyedHash(value, pepper) {
  return crypto.createHmac('sha256', pepper).update(String(value)).digest('hex');
}

/** The stored hash binds the code to one account, so the same digits are useless for anyone else. */
function codeHash(userId, code, pepper) {
  return keyedHash(`reset:${userId}:${code}`, pepper);
}

async function event(client, userId, eventType, reason) {
  await client.query(
    `INSERT INTO password_recovery_events (user_id, event_type, details)
     VALUES ($1, $2, jsonb_build_object('reason', $3::text))`,
    [userId ?? null, eventType, reason],
  );
}

/** Builds recovery operations. Disabled configuration never touches PostgreSQL or email. */
export function createPasswordRecoveryService({
  databasePool = pool,
  config = passwordRecoveryConfig(),
  emailAdapter = config.enabled ? createBrevoEmailAdapter(config) : null,
  now = () => new Date(),
  randomInt = crypto.randomInt,
  randomUUID = crypto.randomUUID,
} = {}) {
  async function requestReset(email, ipAddress) {
    if (!config.enabled) return { kind: 'disabled' };
    if (!databasePool) throw Object.assign(new Error('Password recovery is temporarily unavailable.'), { status: 503 });
    const normalizedEmail = String(email ?? '').trim().toLowerCase();
    const emailKey = keyedHash(normalizedEmail, config.tokenPepper);
    const ipKey = keyedHash(ipAddress || 'unknown', config.tokenPepper);
    const requestedAt = now();
    const client = await databasePool.connect();
    let delivery = null;
    try {
      await client.query('BEGIN');
      const lockKeys = [`recovery-email:${emailKey}`, `recovery-ip:${ipKey}`].sort();
      for (const lockKey of lockKeys) {
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [lockKey]);
      }
      await client.query(
        `DELETE FROM auth_recovery_rate_limits
         WHERE occurred_at <= $1::timestamptz - interval '${RATE_WINDOW_MINUTES} minutes'`,
        [requestedAt],
      );
      const counts = await client.query(
        `SELECT scope, count(*)::int AS count
         FROM auth_recovery_rate_limits
         WHERE occurred_at > $3::timestamptz - interval '${RATE_WINDOW_MINUTES} minutes'
           AND ((scope = 'email' AND identifier_hash = $1)
             OR (scope = 'ip' AND identifier_hash = $2))
         GROUP BY scope`,
        [emailKey, ipKey, requestedAt],
      );
      const countFor = (scope) => counts.rows.find((row) => row.scope === scope)?.count ?? 0;
      if (countFor('email') >= EMAIL_RATE_LIMIT || countFor('ip') >= IP_RATE_LIMIT) {
        await event(client, null, 'reset_throttled', 'rate_limit');
        await client.query('COMMIT');
        return { kind: 'accepted', throttled: true };
      }
      await client.query(
        `INSERT INTO auth_recovery_rate_limits (scope, identifier_hash, occurred_at)
         VALUES ('email', $1, $3), ('ip', $2, $3)`,
        [emailKey, ipKey, requestedAt],
      );

      const userResult = await client.query(
        `SELECT id, email, first_name, account_status
         FROM users WHERE email = $1`,
        [normalizedEmail],
      );
      const user = userResult.rows[0];
      if (user?.account_status === 'active') {
        await client.query(
          `UPDATE password_reset_tokens SET invalidated_at = $2
           WHERE user_id = $1 AND used_at IS NULL AND invalidated_at IS NULL`,
          [user.id, requestedAt],
        );
        const selector = randomUUID();
        const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
        await client.query(
          `INSERT INTO password_reset_tokens
             (selector, user_id, token_hash, expires_at, created_at)
           VALUES ($1, $2, $3, $4::timestamptz + interval '${TOKEN_TTL_MINUTES} minutes', $4)`,
          [selector, user.id, codeHash(user.id, code, config.tokenPepper), requestedAt],
        );
        await event(client, user.id, 'reset_requested', 'customer_request');
        delivery = {
          selector,
          userId: user.id,
          recipient: user.email,
          firstName: user.first_name,
          code,
        };
      }
      await client.query('COMMIT');
      return { kind: 'accepted', delivery };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async function deliverReset(delivery) {
    if (!delivery || !emailAdapter || !config.enabled) return;
    let status = 'sent';
    try {
      await emailAdapter.sendPasswordReset({
        recipient: delivery.recipient,
        firstName: delivery.firstName,
        code: delivery.code,
      });
    } catch {
      status = 'failed';
    }
    const client = await databasePool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        'UPDATE password_reset_tokens SET delivery_status = $2 WHERE selector = $1',
        [delivery.selector, status],
      );
      await event(
        client,
        delivery.userId,
        status === 'sent' ? 'delivery_succeeded' : 'delivery_failed',
        status === 'sent' ? 'provider_accepted' : 'provider_error',
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /** Resets the password with the email address and the latest 6-digit code sent to it. */
  async function resetPassword(email, code, newPassword) {
    if (!config.enabled) return { kind: 'disabled' };
    if (!databasePool) throw Object.assign(new Error('Password recovery is temporarily unavailable.'), { status: 503 });
    const normalizedEmail = String(email ?? '').trim().toLowerCase();
    const changedAt = now();
    const client = await databasePool.connect();
    try {
      await client.query('BEGIN');
      // Only the newest open code for this account can be used; unknown emails look the same as wrong codes.
      const tokenResult = await client.query(
        `SELECT t.id, t.user_id, t.token_hash, t.expires_at, t.used_at, t.invalidated_at, t.failed_attempts
         FROM password_reset_tokens t JOIN users u ON u.id = t.user_id
         WHERE u.email = $1 AND t.used_at IS NULL AND t.invalidated_at IS NULL
         ORDER BY t.created_at DESC, t.id DESC LIMIT 1
         FOR UPDATE OF t`,
        [normalizedEmail],
      );
      const row = tokenResult.rows[0];
      const suppliedHash = row ? codeHash(row.user_id, code, config.tokenPepper) : '';
      const hashMatches = row?.token_hash
        ? crypto.timingSafeEqual(Buffer.from(row.token_hash, 'hex'), Buffer.from(suppliedHash, 'hex'))
        : false;
      const usable = row && hashMatches && !row.used_at && !row.invalidated_at
        && new Date(row.expires_at).getTime() > changedAt.getTime()
        && Number(row.failed_attempts) < TOKEN_FAILURE_LIMIT;
      if (!usable) {
        if (row && !hashMatches && !row.used_at && !row.invalidated_at) {
          const failures = Math.min(TOKEN_FAILURE_LIMIT, Number(row.failed_attempts) + 1);
          await client.query(
            `UPDATE password_reset_tokens
             SET failed_attempts = $2::int,
                 invalidated_at = CASE WHEN $2::int >= $3::int THEN $4::timestamptz ELSE invalidated_at END
             WHERE id = $1`,
            [row.id, failures, TOKEN_FAILURE_LIMIT, changedAt],
          );
          await event(client, row.user_id, 'token_rejected', failures >= TOKEN_FAILURE_LIMIT ? 'attempt_limit' : 'invalid_token');
        }
        await client.query('COMMIT');
        return { kind: 'invalid' };
      }

      const userResult = await client.query(
        `SELECT id, email, first_name, last_name, password_hash, account_status
         FROM users WHERE id = $1 FOR UPDATE`,
        [row.user_id],
      );
      const user = userResult.rows[0];
      if (!user || user.account_status !== 'active') {
        await client.query('UPDATE password_reset_tokens SET invalidated_at = $2 WHERE id = $1', [row.id, changedAt]);
        await client.query('COMMIT');
        return { kind: 'invalid' };
      }
      const passwordError = validatePassword(newPassword, {
        email: user.email,
        firstName: user.first_name,
        lastName: user.last_name,
      });
      if (passwordError) {
        await client.query('ROLLBACK');
        return { kind: 'invalid_password', message: passwordError };
      }
      if (user.password_hash && await bcrypt.compare(newPassword, user.password_hash)) {
        await client.query('ROLLBACK');
        return { kind: 'reused' };
      }
      const passwordHash = await bcrypt.hash(newPassword, 10);
      await client.query(
        `UPDATE users
         SET password_hash = $2, auth_version = auth_version + 1, password_changed_at = $3
         WHERE id = $1`,
        [user.id, passwordHash, changedAt],
      );
      await client.query('UPDATE password_reset_tokens SET used_at = $2 WHERE id = $1', [row.id, changedAt]);
      await client.query(
        `UPDATE password_reset_tokens SET invalidated_at = $2
         WHERE user_id = $1 AND id <> $3 AND used_at IS NULL AND invalidated_at IS NULL`,
        [user.id, changedAt, row.id],
      );
      await event(client, user.id, 'password_reset_succeeded', 'email_recovery');
      await client.query('COMMIT');
      return { kind: 'changed' };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  return { config: () => ({ enabled: config.enabled }), requestReset, deliverReset, resetPassword };
}

export const passwordRecoveryLimits = Object.freeze({
  tokenMinutes: TOKEN_TTL_MINUTES,
  emailRequestsPerHour: EMAIL_RATE_LIMIT,
  ipRequestsPerHour: IP_RATE_LIMIT,
  tokenFailures: TOKEN_FAILURE_LIMIT,
});
