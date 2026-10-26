/**
 * @file verification-service.js
 * @description Reusable identity-verification challenges for sensitive account changes.
 *
 * Security model:
 *  - Codes are 6-digit numeric, generated with crypto.randomInt; only a keyed HMAC-SHA256 of
 *    the code is stored (never plaintext). The pepper comes from the private environment.
 *  - Each challenge is owner-scoped (user_id), operation-bound, single-use, expiring, and
 *    optionally target-bound (HMAC of the new email/phone) so a code can never authorize a
 *    different operation, customer, or target.
 *  - Starting a challenge enforces a resend cooldown plus per-user and per-IP rate limits
 *    (advisory-locked, mirroring password recovery).
 *  - Verification is atomic: the challenge row is locked FOR UPDATE, attempt count is checked
 *    and incremented, and on success the row is marked consumed in the same transaction. A
 *    consumed/expired/attempt-exhausted challenge never authenticates.
 *  - The verified result returns an opaque authorization handle (the challenge public_id) that
 *    the caller must atomically consume together with the account change (future phases), so a
 *    code can never be "spent" independently of the change it authorizes.
 *  - Never logs codes, hashes, tokens, or credentials. Raw codes are returned only to a
 *    delivery adapter, never through an API response.
 */
import crypto from 'node:crypto';
import { pool } from './db.js';
import { verificationConfig } from './runtime-config.js';

const CODE_TTL_MINUTES = 10;
const RESEND_COOLDOWN_SECONDS = 60;
const MAX_ATTEMPTS = 5;
const RATE_WINDOW_MINUTES = 60;
const USER_RATE_LIMIT = 5;
const IP_RATE_LIMIT = 15;
const OPERATIONS = new Set(['change_phone', 'change_email', 'set_password', 'change_password']);

export const VERIFICATION_GENERIC_MESSAGE = 'We could not complete verification. Please try again.';

function keyedHash(value, pepper) {
  return crypto.createHmac('sha256', pepper).update(String(value)).digest('hex');
}

function safeEqualHex(a, b) {
  const left = Buffer.from(String(a), 'utf8');
  const right = Buffer.from(String(b), 'utf8');
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

/** Normalizes a target (email/phone) before hashing so binding is stable. */
function normalizeTarget(target) {
  return target === null || target === undefined ? null : String(target).trim().toLowerCase();
}

/**
 * True when a challenge's security-version binding is missing or no longer matches the account's
 * current auth_version (e.g. a password change bumped it). STRICT: a challenge with a NULL/missing
 * auth_version is treated as stale (rejected) — there is no "unbound is valid" fallback, so every
 * protected authorization must carry a security-version binding. Reads the current value under the
 * caller's transaction.
 */
async function authVersionStale(client, userId, challengeAuthVersion) {
  if (!Number.isInteger(challengeAuthVersion)) return true;
  const { rows } = await client.query('SELECT auth_version FROM users WHERE id = $1', [userId]);
  if (!rows.length) return true;
  return Number(rows[0].auth_version) !== challengeAuthVersion;
}

async function event(client, userId, operation, eventType, reason) {
  await client.query(
    `INSERT INTO verification_events (user_id, operation, event_type, details)
     VALUES ($1, $2, $3, jsonb_build_object('reason', $4::text))`,
    [userId ?? null, operation ?? null, eventType, reason],
  );
}

/**
 * Builds the verification service. Without a configured pepper the engine is unavailable
 * (returns a disabled result) so it never issues weakly-hashed codes.
 */
export function createVerificationService({
  databasePool = pool,
  config = verificationConfig(),
  now = () => new Date(),
  randomUUID = crypto.randomUUID,
  generateCode = () => String(crypto.randomInt(0, 1_000_000)).padStart(6, '0'),
} = {}) {
  const available = () => Boolean(config.pepper && databasePool);

  /**
   * Starts (or resends) a challenge for an authenticated user + operation (+ optional target).
   * Returns the public challenge id and, when the engine is available, the raw code for a
   * delivery adapter. The raw code is NEVER returned to an API response by the route layer.
   */
  async function start({ userId, operation, channel = 'email', target = null, ipAddress, authVersion = null }) {
    if (!available()) return { kind: 'disabled', message: 'Verification is not available right now.' };
    if (!Number.isInteger(userId) || userId <= 0 || !OPERATIONS.has(operation)) {
      return { kind: 'invalid', message: VERIFICATION_GENERIC_MESSAGE };
    }
    // Strict security-version binding: a protected challenge must always record the current
    // authenticated auth_version. Refuse to issue an unbound challenge.
    if (!Number.isInteger(authVersion)) {
      return { kind: 'invalid', message: VERIFICATION_GENERIC_MESSAGE };
    }
    const normalizedTarget = normalizeTarget(target);
    const targetHash = normalizedTarget ? keyedHash(`${operation}:${normalizedTarget}`, config.pepper) : null;
    const startedAt = now();
    const client = await databasePool.connect();
    try {
      await client.query('BEGIN');
      const userKey = keyedHash(`user:${userId}`, config.pepper);
      const ipKey = keyedHash(`ip:${ipAddress || 'unknown'}`, config.pepper);
      for (const lockKey of [`verify-user:${userKey}`, `verify-ip:${ipKey}`].sort()) {
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [lockKey]);
      }
      await client.query(
        `DELETE FROM verification_rate_limits
         WHERE occurred_at <= $1::timestamptz - interval '${RATE_WINDOW_MINUTES} minutes'`,
        [startedAt],
      );
      const counts = await client.query(
        `SELECT scope, count(*)::int AS count FROM verification_rate_limits
         WHERE occurred_at > $3::timestamptz - interval '${RATE_WINDOW_MINUTES} minutes'
           AND ((scope = 'user' AND identifier_hash = $1) OR (scope = 'ip' AND identifier_hash = $2))
         GROUP BY scope`,
        [userKey, ipKey, startedAt],
      );
      const countFor = (scope) => counts.rows.find((row) => row.scope === scope)?.count ?? 0;
      if (countFor('user') >= USER_RATE_LIMIT || countFor('ip') >= IP_RATE_LIMIT) {
        await event(client, userId, operation, 'challenge_throttled', 'rate_limit');
        await client.query('COMMIT');
        return { kind: 'throttled', message: 'Too many verification requests. Please wait and try again.' };
      }

      // Resend cooldown: block if an active challenge for this operation was created recently.
      const recent = await client.query(
        `SELECT created_at FROM verification_challenges
         WHERE user_id = $1 AND operation = $2 AND consumed_at IS NULL
         ORDER BY created_at DESC LIMIT 1`,
        [userId, operation],
      );
      if (recent.rowCount) {
        const ageSeconds = (startedAt.getTime() - new Date(recent.rows[0].created_at).getTime()) / 1000;
        if (ageSeconds < RESEND_COOLDOWN_SECONDS) {
          await client.query('COMMIT');
          return {
            kind: 'cooldown',
            retryAfter: Math.ceil(RESEND_COOLDOWN_SECONDS - ageSeconds),
            message: 'Please wait a moment before requesting another code.',
          };
        }
      }

      // Supersede any prior active challenge for this user+operation (single active challenge).
      await client.query(
        `UPDATE verification_challenges SET consumed_at = $3
         WHERE user_id = $1 AND operation = $2 AND consumed_at IS NULL`,
        [userId, operation, startedAt],
      );
      await client.query(
        `INSERT INTO verification_rate_limits (scope, identifier_hash, occurred_at)
         VALUES ('user', $1, $3), ('ip', $2, $3)`,
        [userKey, ipKey, startedAt],
      );

      const code = generateCode();
      const publicId = randomUUID();
      await client.query(
        `INSERT INTO verification_challenges
           (public_id, user_id, operation, channel, code_hash, target_hash, auth_version, expires_at, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz + interval '${CODE_TTL_MINUTES} minutes', $8)`,
        [publicId, userId, operation, channel, keyedHash(code, config.pepper), targetHash,
          authVersion, startedAt],
      );
      await event(client, userId, operation, 'challenge_started', channel);
      await client.query('COMMIT');
      return {
        kind: 'started',
        challengeId: publicId,
        operation,
        channel,
        expiresInMinutes: CODE_TTL_MINUTES,
        // Raw code for the delivery adapter only; route layer must not echo this to clients.
        code,
      };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Voids a just-created challenge after a CONFIRMED delivery rejection (the code was never sent),
   * so the dead challenge can never be verified or consumed and the user can retry immediately.
   * In one transaction it marks the challenge consumed and releases ONLY the two rate-limit slots
   * (user + ip) that this same challenge inserted, matched by the challenge's own created_at — so
   * unrelated attempts keep their abuse-protection records. Owner + operation + still-active are
   * all required, so this can never void another user's or an already-used challenge. Call this
   * only for an outcome that definitely did not accept the email; NEVER for an ambiguous failure
   * (which must retain the challenge and slot to avoid duplicate sends).
   */
  async function voidFailedDelivery({ userId, challengeId, operation }) {
    if (!available()) return false;
    if (!Number.isInteger(userId) || typeof challengeId !== 'string' || !OPERATIONS.has(operation)) {
      return false;
    }
    const client = await databasePool.connect();
    try {
      await client.query('BEGIN');
      const locked = await client.query(
        `SELECT id, created_at FROM verification_challenges
         WHERE public_id = $1 AND user_id = $2 AND operation = $3 AND consumed_at IS NULL
         FOR UPDATE`,
        [challengeId, userId, operation],
      );
      const row = locked.rows[0];
      if (!row) {
        // Already consumed/verified, wrong owner/operation, or unknown: do nothing (fail closed).
        await client.query('COMMIT');
        return false;
      }
      await client.query(
        'UPDATE verification_challenges SET consumed_at = $2 WHERE id = $1',
        [row.id, now()],
      );
      // Refund ONLY the user-scope slot for this attempt. The user hash is unique to this
      // customer, so matching (identifier_hash, occurred_at = created_at) can never touch another
      // customer's record even if two attempts share a millisecond timestamp. We deliberately do
      // NOT delete the ip-scope slot: the ip hash is shared by every customer behind one IP (NAT),
      // so it is not safely attributable to one attempt and must keep protecting the shared source.
      // The ip slot ages out of the rate window on its own; the generous 15/hour ip ceiling means a
      // single customer's retries never self-lock, while abuse protection for the IP stays intact.
      const userKey = keyedHash(`user:${userId}`, config.pepper);
      await client.query(
        `DELETE FROM verification_rate_limits
         WHERE scope = 'user' AND identifier_hash = $1 AND occurred_at = $2`,
        [userKey, row.created_at],
      );
      // Audit within the existing event vocabulary: voiding consumes the dead challenge.
      await event(client, userId, operation, 'challenge_consumed', 'delivery_rejected');
      await client.query('COMMIT');
      return true;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Atomically verifies a code for an owned challenge. On success returns an authorization
   * handle but does NOT consume the challenge yet, so the caller can bind consumption to the
   * actual account change. Use consume() (same tx as the change) to finalize. For callers that
   * only need proof (no paired write), pass { consume: true } to mark it consumed here.
   */
  async function verify({ userId, challengeId, operation, code, target = null, consume = false }) {
    if (!available()) return { kind: 'disabled', message: 'Verification is not available right now.' };
    if (!Number.isInteger(userId) || typeof challengeId !== 'string' || typeof code !== 'string') {
      return { kind: 'invalid', message: VERIFICATION_GENERIC_MESSAGE };
    }
    const normalizedTarget = normalizeTarget(target);
    const client = await databasePool.connect();
    try {
      await client.query('BEGIN');
      const locked = await client.query(
        `SELECT * FROM verification_challenges WHERE public_id = $1 FOR UPDATE`,
        [challengeId],
      );
      const row = locked.rows[0];
      // Owner, operation, consumption, and expiry checks. Any mismatch fails generically.
      if (!row || row.user_id !== userId || row.operation !== operation
        || row.consumed_at || new Date(row.expires_at) <= now()) {
        if (row && row.user_id === userId) await event(client, userId, operation, 'verify_failed', 'ineligible');
        await client.query('COMMIT');
        return { kind: 'invalid', message: VERIFICATION_GENERIC_MESSAGE };
      }
      // Security-state binding: a password change / auth_version bump since issuance invalidates it.
      if (await authVersionStale(client, userId, row.auth_version)) {
        await client.query('UPDATE verification_challenges SET consumed_at = $2 WHERE id = $1', [row.id, now()]);
        await event(client, userId, operation, 'verify_failed', 'auth_version_changed');
        await client.query('COMMIT');
        return { kind: 'invalid', message: VERIFICATION_GENERIC_MESSAGE };
      }
      // Target binding: a code for one new email/phone cannot authorize a different target.
      const expectedTargetHash = normalizedTarget
        ? keyedHash(`${operation}:${normalizedTarget}`, config.pepper) : null;
      if ((row.target_hash ?? null) !== (expectedTargetHash ?? null)) {
        await client.query(
          'UPDATE verification_challenges SET attempt_count = attempt_count + 1 WHERE id = $1',
          [row.id],
        );
        await event(client, userId, operation, 'verify_failed', 'target_mismatch');
        await client.query('COMMIT');
        return { kind: 'invalid', message: VERIFICATION_GENERIC_MESSAGE };
      }
      if (row.attempt_count >= MAX_ATTEMPTS) {
        // Exhausted: consume so it can no longer be guessed.
        await client.query('UPDATE verification_challenges SET consumed_at = $2 WHERE id = $1', [row.id, now()]);
        await event(client, userId, operation, 'verify_failed', 'attempts_exhausted');
        await client.query('COMMIT');
        return { kind: 'locked', message: 'Too many incorrect codes. Request a new one.' };
      }
      const matches = safeEqualHex(row.code_hash, keyedHash(code, config.pepper));
      if (!matches) {
        await client.query(
          'UPDATE verification_challenges SET attempt_count = attempt_count + 1 WHERE id = $1',
          [row.id],
        );
        await event(client, userId, operation, 'verify_failed', 'incorrect_code');
        await client.query('COMMIT');
        return { kind: 'incorrect', message: 'That code is incorrect. Check it and try again.' };
      }
      // Move the challenge into the explicit VERIFIED state without consuming it, so the final
      // protected-change transaction can atomically consume it. `consume: true` additionally
      // marks it consumed (used by any standalone proof that has no paired account change).
      await client.query(
        `UPDATE verification_challenges
         SET verified_at = COALESCE(verified_at, $2), consumed_at = CASE WHEN $3 THEN $2 ELSE consumed_at END
         WHERE id = $1`,
        [row.id, now(), consume],
      );
      await event(client, userId, operation, consume ? 'challenge_consumed' : 'verify_succeeded',
        consume ? 'verified_standalone' : 'code_matched');
      await client.query('COMMIT');
      return { kind: 'verified', challengeId: row.public_id, operation, consumed: consume };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Consumes a previously-verified challenge using the CALLER'S transaction client, so the
   * account change and the challenge consumption commit or roll back together (no bypass, no
   * inconsistent state). Returns true only if the challenge was still valid and now consumed.
   * Future protected-operation handlers will call this inside their change transaction.
   */
  async function consumeVerified(client, { userId, challengeId, operation, target = null }) {
    if (!config.pepper) return false;
    const normalizedTarget = normalizeTarget(target);
    const expectedTargetHash = normalizedTarget
      ? keyedHash(`${operation}:${normalizedTarget}`, config.pepper) : null;
    const locked = await client.query(
      `SELECT * FROM verification_challenges WHERE public_id = $1 FOR UPDATE`,
      [challengeId],
    );
    const row = locked.rows[0];
    // Requires the explicit VERIFIED state: an issued-but-unverified challenge (verified_at IS
    // NULL) can never authorize a change, and owner/operation/target/expiry/consumption must all
    // hold. This is the only path that marks consumed_at, bound to the caller's transaction.
    if (!row || row.user_id !== userId || row.operation !== operation
      || !row.verified_at || row.consumed_at || new Date(row.expires_at) <= now()
      || (row.target_hash ?? null) !== (expectedTargetHash ?? null)) {
      return false;
    }
    // Final defense-in-depth: re-check the security-state binding inside the change transaction.
    // A password change (auth_version bump) between verify and consume revokes the authorization.
    if (await authVersionStale(client, userId, row.auth_version)) {
      await client.query('UPDATE verification_challenges SET consumed_at = $2 WHERE id = $1', [row.id, now()]);
      await event(client, userId, operation, 'verify_failed', 'auth_version_changed');
      return false;
    }
    await client.query('UPDATE verification_challenges SET consumed_at = $2 WHERE id = $1', [row.id, now()]);
    await event(client, userId, operation, 'challenge_consumed', 'bound_to_change');
    return true;
  }

  return Object.freeze({ available, start, voidFailedDelivery, verify, consumeVerified });
}

export const verificationLimits = Object.freeze({
  codeTtlMinutes: CODE_TTL_MINUTES,
  resendCooldownSeconds: RESEND_COOLDOWN_SECONDS,
  maxAttempts: MAX_ATTEMPTS,
  userRateLimit: USER_RATE_LIMIT,
  ipRateLimit: IP_RATE_LIMIT,
});
