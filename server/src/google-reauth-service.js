/**
 * @file google-reauth-service.js
 * @description Step-up Google reauthentication for Google-linked customers performing a
 * sensitive account change. Verifies a fresh, purpose-bound Google ID token on the backend and
 * requires the Google subject to already be linked to the CURRENT authenticated customer.
 *
 * This is NOT a linking flow: it never links a new Google account and never creates a customer.
 * It issues a one-time nonce (reusing google_auth_nonces) bound to the user, then verifies a
 * token carrying that nonce and matching the user's existing linked subject.
 */
import crypto from 'node:crypto';
import { OAuth2Client } from 'google-auth-library';
import { pool } from './db.js';
import { googleAuthConfig } from './runtime-config.js';

const NONCE_TTL_MINUTES = 10;
const GOOGLE_ISSUERS = new Set(['accounts.google.com', 'https://accounts.google.com']);
const GENERIC_ERROR = 'We could not confirm your Google sign-in. Please try again.';
// Purpose tag mixed into the reauth nonce hash so a login/signup nonce can NEVER satisfy a reauth
// verification (and vice versa). Both services share google_auth_nonces; tagging the stored hash
// makes the two purposes cryptographically non-substitutable without a schema change.
const REAUTH_PURPOSE = 'reauth:change';

function keyedHash(value, pepper) {
  return crypto.createHmac('sha256', pepper).update(String(value)).digest('hex');
}

/** Purpose-bound hash for reauth nonces: distinct from the plain login/signup nonce hash. */
function reauthNonceHash(nonce, pepper) {
  return keyedHash(`${REAUTH_PURPOSE}:${nonce}`, pepper);
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function createGoogleReauthService({
  databasePool = pool,
  config = googleAuthConfig(),
  oauthClient = config.enabled ? new OAuth2Client(config.webClientId) : null,
  now = () => new Date(),
  randomBytes = crypto.randomBytes,
  randomUUID = crypto.randomUUID,
} = {}) {
  const available = () => Boolean(config.enabled && databasePool);

  /** Issues a one-time reauth nonce bound to the authenticated user (reuses google_auth_nonces). */
  async function issueNonce(userId) {
    if (!available()) return { kind: 'disabled' };
    if (!Number.isInteger(userId) || userId <= 0) return { kind: 'invalid' };
    // Only users who already have a linked Google identity may reauthenticate with Google.
    const linked = await databasePool.query(
      'SELECT 1 FROM user_google_identities WHERE user_id = $1',
      [userId],
    );
    if (!linked.rowCount) return { kind: 'not_linked' };
    const selector = randomUUID();
    const nonce = randomBytes(32).toString('base64url');
    const issuedAt = now();
    await databasePool.query(
      `INSERT INTO google_auth_nonces (selector, nonce_hash, intent, expires_at, created_at)
       VALUES ($1, $2, 'login', $3::timestamptz + interval '${NONCE_TTL_MINUTES} minutes', $3)`,
      [selector, reauthNonceHash(nonce, config.noncePepper), issuedAt],
    );
    return { kind: 'issued', selector, nonce };
  }

  /**
   * Verifies a Google ID token for reauthentication of the given authenticated user.
   * Succeeds only when: the nonce is unused/unexpired and matches; the token is valid
   * (sig/iss/aud/exp/email_verified); the token nonce matches; and the token subject equals a
   * subject already linked to THIS user. Consumes the nonce atomically. Never links or creates.
   */
  async function verify({ userId, selector, nonce, idToken }) {
    if (!available()) return { kind: 'disabled' };
    if (!Number.isInteger(userId) || typeof selector !== 'string' || typeof nonce !== 'string') {
      return { kind: 'invalid', message: GENERIC_ERROR };
    }
    const client = await databasePool.connect();
    try {
      await client.query('BEGIN');
      const locked = await client.query(
        'SELECT * FROM google_auth_nonces WHERE selector = $1 FOR UPDATE',
        [selector],
      );
      const row = locked.rows[0];
      if (!row || row.used_at || new Date(row.expires_at) <= now()
        || !safeEqual(row.nonce_hash, reauthNonceHash(nonce, config.noncePepper))) {
        await client.query('ROLLBACK');
        return { kind: 'invalid', message: GENERIC_ERROR };
      }
      // Consume the nonce up front so a replay cannot reuse it even if verification fails later.
      await client.query('UPDATE google_auth_nonces SET used_at = $2 WHERE selector = $1', [selector, now()]);

      let payload;
      try {
        const ticket = await oauthClient.verifyIdToken({ idToken, audience: config.webClientId });
        payload = ticket.getPayload();
      } catch {
        await client.query('COMMIT');
        return { kind: 'invalid', message: GENERIC_ERROR };
      }
      const currentSeconds = Math.floor(now().getTime() / 1000);
      if (!payload || !GOOGLE_ISSUERS.has(payload.iss) || payload.aud !== config.webClientId
        || !payload.sub || payload.email_verified !== true
        || !payload.exp || payload.exp <= currentSeconds || !safeEqual(payload.nonce ?? '', nonce)) {
        await client.query('COMMIT');
        return { kind: 'invalid', message: GENERIC_ERROR };
      }
      // The verified subject must already belong to THIS authenticated customer.
      const match = await client.query(
        'SELECT 1 FROM user_google_identities WHERE user_id = $1 AND google_subject = $2',
        [userId, payload.sub],
      );
      if (!match.rowCount) {
        await client.query('COMMIT');
        return { kind: 'subject_mismatch', message: GENERIC_ERROR };
      }
      await client.query('COMMIT');
      return { kind: 'verified' };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  return Object.freeze({ available, issueNonce, verify });
}
