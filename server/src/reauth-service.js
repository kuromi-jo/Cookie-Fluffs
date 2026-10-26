/**
 * @file reauth-service.js
 * @description Mandatory step-up reauthentication for sensitive account changes (Phase 4 Change
 * Email). A current authenticated session alone is NOT sufficient: the customer must re-prove
 * identity with their current password (local accounts) or a fresh Google reauthentication
 * (Google-linked accounts). A successful check mints a short-lived, server-side, single-use
 * authorization in `reauth_authorizations`, bound to the customer, the operation, and the
 * account's auth_version at issuance. The final change transaction consumes it atomically
 * (consumeReauth) inside its own transaction, so a client boolean or a prior HTTP 200 can never
 * stand in for proof. No password or token is ever stored; only an opaque proof reference.
 */
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { pool } from './db.js';

const PROOF_TTL_MINUTES = 10;
// Operations that may be authorized by a reauth proof. Each proof is bound to exactly one of
// these at issuance and can only be consumed for that same operation (consumeReauth filters by
// operation), so a change_email proof can never authorize set_password and vice versa.
const OPERATIONS = new Set(['change_email', 'set_password']);
const GENERIC_MESSAGE = 'We could not confirm your identity. Please try again.';

async function event(client, userId, eventType, reason) {
  await client.query(
    `INSERT INTO account_security_events (user_id, event_type, details)
     VALUES ($1, $2, jsonb_build_object('reason', $3::text))`,
    [userId ?? null, eventType, reason],
  );
}

/**
 * Builds the reauthentication service.
 * @param {object} deps.googleReauth - google-reauth-service (issueNonce/verify) for the Google path.
 */
export function createReauthService({
  databasePool = pool,
  googleReauth = null,
  now = () => new Date(),
  randomUUID = crypto.randomUUID,
} = {}) {
  const available = () => Boolean(databasePool);

  /** Inserts a single-use proof bound to user + operation + the CURRENT auth_version. */
  async function mintProof(client, { userId, operation, method, authVersion }) {
    const publicId = randomUUID();
    const issuedAt = now();
    await client.query(
      `INSERT INTO reauth_authorizations
         (public_id, user_id, operation, method, auth_version, created_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $6::timestamptz + interval '${PROOF_TTL_MINUTES} minutes')`,
      [publicId, userId, operation, method, authVersion, issuedAt],
    );
    return publicId;
  }

  /**
   * Reauthenticates a local-password customer. Verifies the current password against the stored
   * hash under a row lock, then mints a proof bound to the account's current auth_version.
   */
  async function verifyPassword({ userId, operation, password }) {
    if (!available()) return { kind: 'disabled', message: GENERIC_MESSAGE };
    if (!Number.isInteger(userId) || !OPERATIONS.has(operation) || typeof password !== 'string' || !password
      || password.length > 128) {
      return { kind: 'invalid', message: GENERIC_MESSAGE };
    }
    const client = await databasePool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(
        'SELECT id, password_hash, auth_version, account_status FROM users WHERE id = $1 FOR UPDATE',
        [userId],
      );
      const user = rows[0];
      if (!user || user.account_status !== 'active') {
        await client.query('ROLLBACK');
        return { kind: 'unauthorized', message: GENERIC_MESSAGE };
      }
      if (!user.password_hash) {
        // Google-only account: no local password to reauthenticate with.
        await event(client, userId, 'reauth_failed', 'no_password');
        await client.query('COMMIT');
        return { kind: 'password_unavailable', message: 'This account has no password. Use Google to confirm it\u2019s you.' };
      }
      const matches = await bcrypt.compare(password, user.password_hash);
      if (!matches) {
        await event(client, userId, 'reauth_failed', 'incorrect_password');
        await client.query('COMMIT');
        return { kind: 'invalid_password', message: 'That password is incorrect.' };
      }
      const proofId = await mintProof(client, { userId, operation, method: 'password', authVersion: Number(user.auth_version) });
      await event(client, userId, 'reauth_succeeded', 'password');
      await client.query('COMMIT');
      return { kind: 'authorized', reauthId: proofId };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Reauthenticates a Google-linked customer. Delegates token/nonce/subject verification to the
   * google-reauth-service (which requires the subject to be linked to THIS user), then mints a
   * proof bound to the account's current auth_version.
   */
  async function completeGoogle({ userId, operation, selector, nonce, idToken }) {
    if (!available()) return { kind: 'disabled', message: GENERIC_MESSAGE };
    if (!Number.isInteger(userId) || !OPERATIONS.has(operation) || !googleReauth) {
      return { kind: 'invalid', message: GENERIC_MESSAGE };
    }
    const result = await googleReauth.verify({ userId, selector, nonce, idToken });
    if (result.kind !== 'verified') {
      // Record the failure without leaking which check failed.
      const client = await databasePool.connect();
      try {
        await client.query('BEGIN');
        await event(client, userId, 'reauth_failed', 'google');
        await client.query('COMMIT');
      } catch {
        await client.query('ROLLBACK').catch(() => undefined);
      } finally {
        client.release();
      }
      return { kind: result.kind === 'disabled' ? 'disabled' : 'invalid', message: GENERIC_MESSAGE };
    }
    const client = await databasePool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(
        'SELECT auth_version, account_status FROM users WHERE id = $1 FOR UPDATE',
        [userId],
      );
      const user = rows[0];
      if (!user || user.account_status !== 'active') {
        await client.query('ROLLBACK');
        return { kind: 'unauthorized', message: GENERIC_MESSAGE };
      }
      const proofId = await mintProof(client, { userId, operation, method: 'google', authVersion: Number(user.auth_version) });
      await event(client, userId, 'reauth_succeeded', 'google');
      await client.query('COMMIT');
      return { kind: 'authorized', reauthId: proofId };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Consumes a reauth proof inside the CALLER'S transaction (same tx as the account change), so
   * the proof and the change commit or roll back together. Returns true only when the proof is
   * owned, matches the operation, is unconsumed/unexpired, and its auth_version still matches the
   * account's current auth_version (a password change since issuance revokes it). Single-use.
   */
  async function consumeReauth(client, { userId, proofId, operation, authVersion }) {
    if (!Number.isInteger(userId) || typeof proofId !== 'string' || !proofId || !OPERATIONS.has(operation)) {
      return false;
    }
    const locked = await client.query(
      `SELECT id, auth_version, expires_at, consumed_at
       FROM reauth_authorizations
       WHERE public_id = $1 AND user_id = $2 AND operation = $3
       FOR UPDATE`,
      [proofId, userId, operation],
    );
    const row = locked.rows[0];
    if (!row || row.consumed_at || new Date(row.expires_at) <= now()) return false;
    // Strict security-version binding: the proof must match the account's current auth_version,
    // and the auth_version asserted by the change transaction (defense in depth).
    if (!Number.isInteger(authVersion) || Number(row.auth_version) !== authVersion) return false;
    await client.query('UPDATE reauth_authorizations SET consumed_at = $2 WHERE id = $1', [row.id, now()]);
    return true;
  }

  return Object.freeze({ available, verifyPassword, completeGoogle, consumeReauth });
}
