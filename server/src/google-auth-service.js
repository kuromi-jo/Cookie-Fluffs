/**
 * @file google-auth-service.js
 * @description One-time Google identity verification, signup, and explicit account linking.
 */
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { OAuth2Client } from 'google-auth-library';
import { pool } from './db.js';
import { googleAuthConfig } from './runtime-config.js';
import {
  joinName, normalizePhone, validateFirstName, validateLastName, validatePhone,
} from './validation.js';

const NONCE_TTL_MINUTES = 10;
const CHALLENGE_TTL_MINUTES = 10;
const GOOGLE_ISSUERS = new Set(['accounts.google.com', 'https://accounts.google.com']);
const GENERIC_ERROR = 'Google sign-in could not be completed. Please try again.';
const VALID_INTENTS = new Set(['login', 'signup']);
const SIGNUP_NEEDED_MESSAGE = 'No Cookie Fluffs account is linked to this Google account. Please sign up first.';
const LOGIN_REQUIRED_MESSAGE = 'This Google account is already registered. Please log in instead.';
export const GOOGLE_LINK_RESTART_CODE = 'google_link_restart_required';
const GOOGLE_LINK_RESTART_MESSAGE = "We couldn't confirm your Cookie Fluffs password. Select Continue with Google to try again.";

function linkRestartRequired() {
  return {
    kind: 'restart_required',
    code: GOOGLE_LINK_RESTART_CODE,
    message: GOOGLE_LINK_RESTART_MESSAGE,
  };
}

function keyedHash(value, pepper) {
  return crypto.createHmac('sha256', pepper).update(String(value)).digest('hex');
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function cleanName(value, fallback) {
  const cleaned = String(value ?? '').trim().replace(/\s+/g, ' ').slice(0, 80);
  return cleaned || fallback;
}

async function securityEvent(client, userId, eventType, reason) {
  await client.query(
    `INSERT INTO google_auth_events (user_id, event_type, details)
     VALUES ($1, $2, jsonb_build_object('reason', $3::text))`,
    [userId ?? null, eventType, reason],
  );
}

/** Creates the disabled-by-default Google identity workflow. */
export function createGoogleAuthService({
  databasePool = pool,
  config = googleAuthConfig(),
  oauthClient = config.enabled ? new OAuth2Client(config.webClientId) : null,
  now = () => new Date(),
  randomBytes = crypto.randomBytes,
  randomUUID = crypto.randomUUID,
} = {}) {
  const publicConfig = () => config.enabled
    ? { enabled: true, webClientId: config.webClientId }
    : { enabled: false };

  async function verifyIdToken(idToken, expectedNonce) {
    if (typeof idToken !== 'string' || idToken.length < 100 || idToken.length > 10_000) throw new Error(GENERIC_ERROR);
    const ticket = await oauthClient.verifyIdToken({ idToken, audience: config.webClientId });
    const payload = ticket.getPayload();
    const currentSeconds = Math.floor(now().getTime() / 1000);
    if (!payload || !GOOGLE_ISSUERS.has(payload.iss) || payload.aud !== config.webClientId
      || !payload.sub || !payload.email || payload.email_verified !== true
      || !payload.exp || payload.exp <= currentSeconds || !safeEqual(payload.nonce, expectedNonce)) {
      throw new Error(GENERIC_ERROR);
    }
    return {
      subject: payload.sub,
      email: payload.email.trim().toLowerCase(),
      firstName: cleanName(payload.given_name, 'Cookie'),
      lastName: cleanName(payload.family_name, 'Customer'),
    };
  }

  async function issueNonce({ intent } = {}) {
    if (!config.enabled) return { kind: 'disabled' };
    // Intent must be explicit at issuance; a missing or unknown intent is never
    // defaulted to signup, so a login attempt can never silently create an account.
    if (!VALID_INTENTS.has(intent)) return { kind: 'invalid', message: GENERIC_ERROR };
    if (!databasePool) throw Object.assign(new Error('Google sign-in is temporarily unavailable.'), { status: 503 });
    const selector = randomUUID();
    const nonce = randomBytes(32).toString('base64url');
    const issuedAt = now();
    await databasePool.query(
      `INSERT INTO google_auth_nonces (selector, nonce_hash, intent, expires_at, created_at)
       VALUES ($1, $2, $3, $4::timestamptz + interval '${NONCE_TTL_MINUTES} minutes', $4)`,
      [selector, keyedHash(nonce, config.noncePepper), intent, issuedAt],
    );
    return { kind: 'issued', selector, nonce };
  }

  async function authenticate({ selector, nonce, idToken }) {
    if (!config.enabled) return { kind: 'disabled', message: 'Google sign-in is not available right now.' };
    if (!databasePool || typeof selector !== 'string' || typeof nonce !== 'string') return { kind: 'invalid', message: GENERIC_ERROR };

    const preliminary = await databasePool.query(
      `SELECT nonce_hash, expires_at, used_at FROM google_auth_nonces WHERE selector = $1`,
      [selector],
    );
    const attempt = preliminary.rows[0];
    if (!attempt || attempt.used_at || new Date(attempt.expires_at) <= now()
      || !safeEqual(attempt.nonce_hash, keyedHash(nonce, config.noncePepper))) {
      return { kind: 'invalid', message: GENERIC_ERROR };
    }

    let identity;
    try {
      identity = await verifyIdToken(idToken, nonce);
    } catch {
      return { kind: 'invalid', message: GENERIC_ERROR };
    }

    const client = await databasePool.connect();
    try {
      await client.query('BEGIN');
      const locked = await client.query('SELECT * FROM google_auth_nonces WHERE selector = $1 FOR UPDATE', [selector]);
      const row = locked.rows[0];
      if (!row || row.used_at || new Date(row.expires_at) <= now()
        || !safeEqual(row.nonce_hash, keyedHash(nonce, config.noncePepper))) {
        await client.query('ROLLBACK');
        return { kind: 'invalid', message: GENERIC_ERROR };
      }
      await client.query('UPDATE google_auth_nonces SET used_at = $2 WHERE selector = $1', [selector, now()]);
      // Intent is read from the server-issued row, never from the request, so it
      // cannot be flipped after issuance. Rows predating this column are treated as login.
      const intent = row.intent === 'signup' ? 'signup' : 'login';

      const linked = await client.query(
        `SELECT users.* FROM user_google_identities identities
         JOIN users ON users.id = identities.user_id
         WHERE identities.google_subject = $1 FOR UPDATE OF users`,
        [identity.subject],
      );
      if (linked.rowCount) {
        const user = linked.rows[0];
        if (user.account_status !== 'active') {
          await securityEvent(client, user.id, 'google_login_rejected', 'account_unavailable');
          await client.query('COMMIT');
          return { kind: 'invalid', message: GENERIC_ERROR };
        }
        // Sign up with an already-linked identity: guide the user to Login instead of
        // silently authenticating, so the two flows stay distinct.
        if (intent === 'signup') {
          await securityEvent(client, user.id, 'google_login_rejected', 'login_required');
          await client.query('COMMIT');
          return { kind: 'login_required', message: LOGIN_REQUIRED_MESSAGE };
        }
        await client.query(
          'UPDATE user_google_identities SET last_login_at = $2 WHERE google_subject = $1',
          [identity.subject, now()],
        );
        await securityEvent(client, user.id, 'google_login_succeeded', 'verified_identity');
        await client.query('COMMIT');
        return { kind: 'authenticated', user };
      }

      const existing = await client.query('SELECT * FROM users WHERE email = $1 FOR UPDATE', [identity.email]);
      if (existing.rowCount && existing.rows[0].account_status !== 'active') {
        await securityEvent(client, existing.rows[0].id, 'google_login_rejected', 'account_unavailable');
        await client.query('COMMIT');
        return { kind: 'invalid', message: GENERIC_ERROR };
      }
      // Unregistered Google identity selected on the Login tab: never create an account.
      // The nonce stays consumed (used_at is set) so this attempt cannot be replayed as a signup.
      if (!existing.rowCount && intent === 'login') {
        await securityEvent(client, null, 'google_login_rejected', 'signup_needed');
        await client.query('COMMIT');
        return { kind: 'signup_needed', message: SIGNUP_NEEDED_MESSAGE };
      }
      const challenge = randomBytes(32).toString('base64url');
      const state = existing.rowCount ? 'link_required' : 'signup_required';
      await client.query(
        `UPDATE google_auth_nonces
         SET challenge_hash = $2, google_subject = $3, verified_email = $4,
             first_name = $5, last_name = $6, state = $7,
             challenge_expires_at = $8::timestamptz + interval '${CHALLENGE_TTL_MINUTES} minutes'
         WHERE selector = $1`,
        [selector, keyedHash(challenge, config.noncePepper), identity.subject, identity.email,
          identity.firstName, identity.lastName, state, now()],
      );
      await client.query('COMMIT');
      return state === 'link_required'
        ? { kind: state, selector, challenge, message: 'Confirm your Cookie Fluffs password to link Google.' }
        : { kind: state, selector, challenge, profile: {
            email: identity.email, firstName: identity.firstName, lastName: identity.lastName,
          } };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async function lockedChallenge(client, selector, challenge, state) {
    const result = await client.query('SELECT * FROM google_auth_nonces WHERE selector = $1 FOR UPDATE', [selector]);
    const row = result.rows[0];
    if (!row || row.state !== state || row.completed_at || !row.challenge_hash
      || new Date(row.challenge_expires_at) <= now()
      || !safeEqual(row.challenge_hash, keyedHash(challenge, config.noncePepper))) return null;
    return row;
  }

  async function completeSignup({ selector, challenge, firstName, lastName, phone, acceptedTerms }) {
    if (!config.enabled) return { kind: 'disabled', message: 'Google sign-up is not available right now.' };
    // Names are prefilled from Google's verified profile but the customer may review and
    // edit them, so validate the submitted values with the shared account validators.
    const firstNameError = validateFirstName(firstName);
    const lastNameError = validateLastName(lastName);
    const phoneError = validatePhone(String(phone ?? ''));
    if (firstNameError || lastNameError || phoneError || acceptedTerms !== true) {
      return {
        kind: 'invalid',
        message: firstNameError || lastNameError || phoneError
          || 'Agree to the Terms of Use and Privacy Policy to continue.',
      };
    }
    const cleanFirstName = String(firstName).trim().replace(/\s+/g, ' ');
    const cleanLastName = String(lastName).trim().replace(/\s+/g, ' ');
    const client = await databasePool.connect();
    try {
      await client.query('BEGIN');
      const attempt = await lockedChallenge(client, selector, challenge, 'signup_required');
      if (!attempt) {
        await client.query('ROLLBACK');
        return { kind: 'invalid', message: GENERIC_ERROR };
      }
      const userResult = await client.query(
        `INSERT INTO users (first_name, last_name, full_name, email, phone, password_hash)
         VALUES ($1, $2, $3, $4, $5, NULL) RETURNING *`,
        [cleanFirstName, cleanLastName, joinName(cleanFirstName, cleanLastName),
          attempt.verified_email, normalizePhone(phone)],
      );
      const user = userResult.rows[0];
      await client.query(
        `INSERT INTO user_google_identities (user_id, google_subject, last_login_at)
         VALUES ($1, $2, $3)`,
        [user.id, attempt.google_subject, now()],
      );
      await client.query('UPDATE google_auth_nonces SET completed_at = $2 WHERE selector = $1', [selector, now()]);
      await securityEvent(client, user.id, 'google_signup_succeeded', 'verified_identity');
      await client.query('COMMIT');
      return { kind: 'authenticated', user };
    } catch (error) {
      await client.query('ROLLBACK');
      if (error.code === '23505') return { kind: 'invalid', message: GENERIC_ERROR };
      throw error;
    } finally {
      client.release();
    }
  }

  async function linkAccount({ selector, challenge, password }) {
    if (!config.enabled) return { kind: 'disabled', message: 'Google sign-in is not available right now.' };
    if (typeof password !== 'string' || !password || password.length > 128) return { kind: 'invalid', message: GENERIC_ERROR };
    const client = await databasePool.connect();
    try {
      await client.query('BEGIN');
      const attempt = await lockedChallenge(client, selector, challenge, 'link_required');
      if (!attempt) {
        await client.query('ROLLBACK');
        return linkRestartRequired();
      }
      const userResult = await client.query('SELECT * FROM users WHERE email = $1 FOR UPDATE', [attempt.verified_email]);
      const user = userResult.rows[0];
      const matches = user?.account_status === 'active' && user.password_hash
        && await bcrypt.compare(password, user.password_hash);
      if (!matches) {
        await client.query('UPDATE google_auth_nonces SET completed_at = $2 WHERE selector = $1', [selector, now()]);
        await securityEvent(client, user?.id, 'google_link_rejected', 'password_confirmation_failed');
        await client.query('COMMIT');
        return linkRestartRequired();
      }
      await client.query(
        `INSERT INTO user_google_identities (user_id, google_subject, last_login_at)
         VALUES ($1, $2, $3)`,
        [user.id, attempt.google_subject, now()],
      );
      await client.query('UPDATE google_auth_nonces SET completed_at = $2 WHERE selector = $1', [selector, now()]);
      await securityEvent(client, user.id, 'google_link_succeeded', 'password_confirmed');
      await client.query('COMMIT');
      return { kind: 'authenticated', user };
    } catch (error) {
      await client.query('ROLLBACK');
      if (error.code === '23505') return { kind: 'invalid', message: GENERIC_ERROR };
      throw error;
    } finally {
      client.release();
    }
  }

  return Object.freeze({ config: publicConfig, issueNonce, authenticate, completeSignup, linkAccount });
}

export const googleAuthLimits = Object.freeze({ nonceMinutes: NONCE_TTL_MINUTES, challengeMinutes: CHALLENGE_TTL_MINUTES });
