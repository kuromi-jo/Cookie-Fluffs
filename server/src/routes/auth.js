/**
 * @file auth.js (routes)
 * @description Sign up, log in, and the current user's profile.
 */
import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { pool, query } from '../db.js';
import { createRequireAuth, signToken, toPublicUser } from '../auth.js';
import { changeCustomerPassword } from '../account-security-service.js';
import { changeCustomerPhone } from '../change-phone-service.js';
import { changeCustomerEmail } from '../change-email-service.js';
import { setCustomerPassword } from '../set-password-service.js';
import { createVerificationService } from '../verification-service.js';
import { createReauthService } from '../reauth-service.js';
import { createGoogleReauthService } from '../google-reauth-service.js';
import {
  createPasswordRecoveryService,
  RECOVERY_GENERIC_MESSAGE,
  RECOVERY_INVALID_MESSAGE,
} from '../password-recovery-service.js';
import { createGoogleAuthService, GOOGLE_LINK_RESTART_CODE } from '../google-auth-service.js';
import {
  joinName,
  normalizePhone,
  splitFullName,
  validateDateOfBirth,
  validateEmail,
  validateFirstName,
  validateFullName,
  validateGender,
  validateLastName,
  validatePassword,
  validatePhone,
} from '../validation.js';

const MAX_AVATAR_LENGTH = 400_000; // ~300 KB image as a data URL
const AVATAR_ERROR = 'Profile photo must be an image under 300 KB.';
const DUPLICATE_EMAIL_ERROR = 'That email already has an account. Try logging in.';
// NOTE (Phase 3 transition): `phone` remains editable here for now. When the verified
// Change Phone workflow lands, `phone` must be REMOVED from this set so the ordinary
// profile PUT can no longer change the saved number without identity verification.
// `email` is intentionally excluded and stays read-only until the approved Change Email phase.
// `phone` is NO LONGER editable here: it requires the verified Change Phone flow below.
const PROFILE_FIELDS = new Set(['firstName', 'lastName', 'avatar', 'gender', 'dateOfBirth']);
const PASSWORD_CHANGE_FIELDS = new Set(['currentPassword', 'newPassword']);
const CHANGE_PHONE_FIELDS = new Set(['challengeId', 'newPhone']);
const CHANGE_EMAIL_FIELDS = new Set(['reauthId', 'challengeId', 'newEmail']);
const SET_PASSWORD_FIELDS = new Set(['reauthId', 'challengeId', 'newPassword']);
// `operation` is optional and allowlisted; absent means change_email (backward compatible).
const REAUTH_PASSWORD_FIELDS = new Set(['method', 'password', 'operation']);
const REAUTH_PASSWORD_REQUIRED = new Set(['method', 'password']);
const REAUTH_GOOGLE_FIELDS = new Set(['method', 'selector', 'nonce', 'idToken', 'operation']);
const REAUTH_GOOGLE_REQUIRED = new Set(['method', 'selector', 'nonce', 'idToken']);
const REAUTH_OPERATIONS = new Set(['change_email', 'set_password']);
const FORGOT_PASSWORD_FIELDS = new Set(['email']);
const RESET_PASSWORD_FIELDS = new Set(['selector', 'token', 'newPassword']);
const GOOGLE_AUTH_FIELDS = new Set(['selector', 'nonce', 'idToken']);
const GOOGLE_SIGNUP_FIELDS = new Set(['selector', 'challenge', 'firstName', 'lastName', 'phone', 'acceptedTerms']);
const GOOGLE_LINK_FIELDS = new Set(['selector', 'challenge', 'password']);
const GOOGLE_INTENTS = new Set(['login', 'signup']);

function hasExactFields(body, allowed) {
  return body && Object.keys(body).length === allowed.size
    && Object.keys(body).every((field) => allowed.has(field));
}

function sendValidationFailure(res, errors) {
  const fieldOrder = ['firstName', 'lastName', 'email', 'phone', 'password', 'avatar'];
  const message = fieldOrder.map((field) => errors[field]).find(Boolean) ?? Object.values(errors)[0];
  return res.status(400).json({ message, errors });
}

function cleanAvatar(avatar) {
  if (!avatar) return null;
  if (typeof avatar !== 'string' || !avatar.startsWith('data:image/') || avatar.length > MAX_AVATAR_LENGTH) {
    return null;
  }
  return avatar;
}

export function createAuthRouter(
  dbQuery = query,
  {
    authenticate = createRequireAuth(dbQuery),
    changePassword = (userId, currentPassword, newPassword) => changeCustomerPassword(
      userId,
      currentPassword,
      newPassword,
      { databasePool: pool },
    ),
    recovery = createPasswordRecoveryService(),
    googleAuth = createGoogleAuthService(),
    verification = createVerificationService(),
    changePhone = (userId, input) => changeCustomerPhone(userId, input, { databasePool: pool, verification }),
    reauth = createReauthService({ googleReauth: createGoogleReauthService() }),
    changeEmail = (userId, input) => changeCustomerEmail(userId, input, { databasePool: pool, verification, reauth }),
    setPassword = (userId, input) => setCustomerPassword(userId, input, { databasePool: pool, verification, reauth }),
  } = {},
) {
  const router = Router();

// POST /api/auth/signup
router.post('/signup', async (req, res, next) => {
  try {
    const legacyName = req.body.fullName !== undefined &&
      req.body.firstName === undefined && req.body.lastName === undefined;
    let firstName;
    let lastName;
    const errors = {};
    if (legacyName) {
      const fullName = String(req.body.fullName || '').trim();
      const fullNameError = validateFullName(fullName);
      if (fullNameError) errors.fullName = fullNameError;
      ({ firstName, lastName } = splitFullName(fullName));
    } else {
      firstName = String(req.body.firstName || '').trim();
      lastName = String(req.body.lastName || '').trim();
      const firstNameError = validateFirstName(firstName);
      const lastNameError = validateLastName(lastName);
      if (firstNameError) errors.firstName = firstNameError;
      if (lastNameError) errors.lastName = lastNameError;
    }

    const fullName = joinName(firstName, lastName);
    const email = String(req.body.email || '').trim().toLowerCase();
    const phone = String(req.body.phone || '').trim();
    const password = String(req.body.password || '');
    const emailError = validateEmail(email);
    const phoneError = validatePhone(phone);
    const passwordError = validatePassword(password, { email, firstName, lastName });
    if (emailError) errors.email = emailError;
    if (phoneError) errors.phone = phoneError;
    if (passwordError) errors.password = passwordError;

    let avatar = null;
    if (req.body.avatar) {
      avatar = cleanAvatar(req.body.avatar);
      if (!avatar) errors.avatar = AVATAR_ERROR;
    }
    if (Object.keys(errors).length) return sendValidationFailure(res, errors);

    const exists = await dbQuery('SELECT 1 FROM users WHERE email = $1', [email]);
    if (exists.rowCount) {
      return res.status(409).json({ message: DUPLICATE_EMAIL_ERROR, errors: { email: DUPLICATE_EMAIL_ERROR } });
    }

    const hash = await bcrypt.hash(password, 10);
    try {
      const { rows } = await dbQuery(
        `INSERT INTO users (first_name, last_name, full_name, email, phone, avatar, password_hash)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [firstName, lastName, fullName, email, normalizePhone(phone), avatar, hash],
      );
      res.status(201).json({ token: signToken(rows[0]), user: toPublicUser(rows[0]) });
    } catch (err) {
      if (err.code === '23505') {
        return res.status(409).json({ message: DUPLICATE_EMAIL_ERROR, errors: { email: DUPLICATE_EMAIL_ERROR } });
      }
      throw err;
    }
  } catch (err) {
    next(err);
  }
});

// POST /api/auth/login
router.post('/login', async (req, res, next) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    if (password.length > 128) return res.status(401).json({ message: 'Wrong email or password.' });
    const { rows } = await dbQuery('SELECT * FROM users WHERE email = $1', [email]);
    const ok = rows.length && rows[0].password_hash && (await bcrypt.compare(password, rows[0].password_hash));
    if (!ok || (rows[0].account_status && rows[0].account_status !== 'active')) {
      return res.status(401).json({ message: 'Wrong email or password.' });
    }
    res.json({ token: signToken(rows[0]), user: toPublicUser(rows[0]) });
  } catch (err) {
    next(err);
  }
});

// GET /api/auth/me
router.get('/me', authenticate, async (req, res, next) => {
  try {
    const { rows } = await dbQuery('SELECT * FROM users WHERE id = $1', [req.userId]);
    if (!rows.length) return res.status(401).json({ message: 'Account not found. Please log in again.' });
    res.json(toPublicUser(rows[0]));
  } catch (err) {
    next(err);
  }
});

// GET /api/auth/account-status
// Owner-scoped, read-only view of which sign-in methods the account has. Returns
// only booleans; never the password hash, Google subject, tokens, or any secret.
router.get('/account-status', authenticate, async (req, res, next) => {
  try {
    const { rows } = await dbQuery(
      `SELECT (users.password_hash IS NOT NULL) AS "hasPassword",
              EXISTS (
                SELECT 1 FROM user_google_identities
                WHERE user_google_identities.user_id = users.id
              ) AS "googleLinked"
       FROM users WHERE users.id = $1`,
      [req.userId],
    );
    if (!rows.length) return res.status(401).json({ message: 'Account not found. Please log in again.' });
    return res.json({
      hasPassword: rows[0].hasPassword,
      google: { linked: rows[0].googleLinked },
    });
  } catch (err) {
    return next(err);
  }
});

// PUT /api/auth/me  (update first name, last name, phone, or photo)
router.put('/me', authenticate, async (req, res, next) => {
  try {
    const unknownField = Object.keys(req.body ?? {}).find((field) => !PROFILE_FIELDS.has(field));
    if (unknownField) {
      return res.status(400).json({
        message: `Unknown profile field: ${unknownField}.`,
        errors: { profile: `Unknown profile field: ${unknownField}.` },
      });
    }
    const firstName = req.body.firstName !== undefined ? String(req.body.firstName).trim() : undefined;
    const lastName = req.body.lastName !== undefined ? String(req.body.lastName).trim() : undefined;
    const phone = req.body.phone !== undefined ? String(req.body.phone).trim() : undefined;
    const errors = {};
    if (firstName !== undefined) {
      const error = validateFirstName(firstName);
      if (error) errors.firstName = error;
    }
    if (lastName !== undefined) {
      const error = validateLastName(lastName);
      if (error) errors.lastName = error;
    }
    const normalizedPhone = phone !== undefined ? normalizePhone(phone) : undefined;
    if (phone !== undefined && !normalizedPhone) errors.phone = validatePhone(phone);
    let avatar = undefined;
    if (req.body.avatar !== undefined) {
      avatar = cleanAvatar(req.body.avatar);
      if (req.body.avatar && !avatar) errors.avatar = AVATAR_ERROR;
    }

    // Optional gender / date of birth. An explicit null (or empty string) clears the value.
    const genderProvided = req.body.gender !== undefined;
    let gender = genderProvided
      ? (req.body.gender === null || req.body.gender === '' ? null : String(req.body.gender))
      : undefined;
    if (genderProvided) {
      const error = validateGender(gender);
      if (error) errors.gender = error;
    }
    const dobProvided = req.body.dateOfBirth !== undefined;
    let dateOfBirth = dobProvided
      ? (req.body.dateOfBirth === null || req.body.dateOfBirth === '' ? null : String(req.body.dateOfBirth).trim())
      : undefined;
    if (dobProvided) {
      const error = validateDateOfBirth(dateOfBirth);
      if (error) errors.dateOfBirth = error;
    }
    if (Object.keys(errors).length) return sendValidationFailure(res, errors);

    const currentResult = await dbQuery('SELECT * FROM users WHERE id = $1', [req.userId]);
    if (!currentResult.rows.length) {
      return res.status(401).json({ message: 'Account not found. Please log in again.' });
    }
    const current = currentResult.rows[0];
    const fallbackName = splitFullName(current.full_name);
    const mergedFirstName = firstName ?? current.first_name ?? fallbackName.firstName;
    const mergedLastName = lastName ?? current.last_name ?? fallbackName.lastName;

    const { rows } = await dbQuery(
      `UPDATE users SET
         first_name = $2,
         last_name  = $3,
         full_name  = $4,
         phone      = COALESCE($5, phone),
         avatar     = CASE WHEN $7 THEN $6 ELSE avatar END,
         gender         = CASE WHEN $9  THEN $8::text  ELSE gender END,
         date_of_birth  = CASE WHEN $11 THEN $10::date ELSE date_of_birth END
       WHERE id = $1 RETURNING *`,
      [
        req.userId,
        mergedFirstName,
        mergedLastName,
        joinName(mergedFirstName, mergedLastName),
        normalizedPhone ?? null,
        avatar ?? null,
        avatar !== undefined,
        gender ?? null,
        genderProvided,
        dateOfBirth ?? null,
        dobProvided,
      ],
    );
    res.json(toPublicUser(rows[0]));
  } catch (err) {
    next(err);
  }
});

// POST /api/auth/change-password
router.post('/change-password', authenticate, async (req, res, next) => {
  try {
    const body = req.body ?? {};
    const unknownField = Object.keys(body).find((field) => !PASSWORD_CHANGE_FIELDS.has(field));
    if (unknownField || Object.keys(body).length !== PASSWORD_CHANGE_FIELDS.size) {
      return res.status(400).json({ message: 'Enter your current password and a new password.' });
    }
    if (typeof body.currentPassword !== 'string' || typeof body.newPassword !== 'string'
      || !body.currentPassword || !body.newPassword || body.currentPassword.length > 128
      || body.newPassword.length > 128) {
      return res.status(400).json({ message: 'Enter your current password and a valid new password.' });
    }

    const result = await changePassword(req.userId, body.currentPassword, body.newPassword);
    if (result.kind === 'unauthorized') {
      return res.status(401).json({ message: 'Your session expired. Please log in again.' });
    }
    if (result.kind === 'throttled') {
      res.set?.('Retry-After', String(result.retryAfter));
      return res.status(429).json({
        message: 'Too many password attempts. Wait a few minutes and try again.',
        retryAfter: result.retryAfter,
      });
    }
    if (result.kind === 'invalid_current') {
      return res.status(400).json({
        message: 'Your current password is incorrect.',
        errors: { currentPassword: 'Enter your current password again.' },
      });
    }
    if (result.kind === 'password_unavailable') {
      return res.status(400).json({ message: 'This account does not have a password to change.' });
    }
    if (result.kind === 'invalid_new') {
      return res.status(400).json({ message: result.message, errors: { newPassword: result.message } });
    }
    if (result.kind === 'reused') {
      const message = 'Choose a new password that is different from your current password.';
      return res.status(400).json({ message, errors: { newPassword: message } });
    }
    return res.json({ token: signToken(result.user), user: toPublicUser(result.user) });
  } catch (error) {
    return next(error);
  }
});

// POST /api/auth/change-phone  { challengeId, newPhone }
// Atomically consumes a VERIFIED change_phone challenge (bound to this user + new number) and
// updates the saved phone. Verifying a code alone does not change anything until this call.
router.post('/change-phone', authenticate, async (req, res, next) => {
  try {
    const body = req.body ?? {};
    if (!body || typeof body !== 'object' || Array.isArray(body)
      || Object.keys(body).length !== CHANGE_PHONE_FIELDS.size
      || Object.keys(body).some((field) => !CHANGE_PHONE_FIELDS.has(field))) {
      return res.status(400).json({ message: 'Confirm the verification code to change your number.' });
    }
    const result = await changePhone(req.userId, { challengeId: body.challengeId, newPhone: body.newPhone });
    if (result.kind === 'changed') return res.json({ user: toPublicUser(result.user) });
    if (result.kind === 'invalid_phone') {
      return res.status(400).json({
        message: 'Enter a Philippine mobile number, like 0917 123 4567.',
        errors: { newPhone: 'Enter a Philippine mobile number, like 0917 123 4567.' },
      });
    }
    if (result.kind === 'unauthorized') {
      return res.status(401).json({ message: 'Your session expired. Please log in again.' });
    }
    // unverified: the challenge was not verified, is expired/consumed, or does not match.
    return res.status(409).json({ message: 'Verify your identity again to change your number.' });
  } catch (error) {
    return next(error);
  }
});

// POST /api/auth/reauth  { method:'password', password } | { method:'google', selector, nonce, idToken }
// Mandatory step-up for sensitive changes. On success returns an opaque, single-use reauthId
// bound to the customer + change_email + current auth_version; it is consumed only by the final
// change transaction. Never returns the password, token, or any secret.
router.post('/reauth', authenticate, async (req, res, next) => {
  try {
    const body = req.body ?? {};
    const method = body?.method;
    // Operation the proof will be bound to; optional and allowlisted, default change_email.
    const operation = body?.operation ?? 'change_email';
    if (!REAUTH_OPERATIONS.has(operation)) {
      return res.status(400).json({ message: 'Confirm your identity to continue.' });
    }
    // Every key must be allowed (no extras) and every required key present. Unlike hasExactFields,
    // this permits the optional `operation` field without requiring it.
    const hasRequired = (required, allowed) =>
      body && typeof body === 'object' && !Array.isArray(body)
      && Object.keys(body).every((field) => allowed.has(field))
      && [...required].every((field) => field in body);

    let result;
    if (method === 'password' && hasRequired(REAUTH_PASSWORD_REQUIRED, REAUTH_PASSWORD_FIELDS)) {
      // Password reauth is only offered for accounts that have a password (change_email). A
      // Google-only Set Password cannot use it; the service also returns password_unavailable.
      result = await reauth.verifyPassword({ userId: req.userId, operation, password: body.password });
    } else if (method === 'google' && hasRequired(REAUTH_GOOGLE_REQUIRED, REAUTH_GOOGLE_FIELDS)) {
      result = await reauth.completeGoogle({
        userId: req.userId,
        operation,
        selector: body.selector,
        nonce: body.nonce,
        idToken: body.idToken,
      });
    } else {
      return res.status(400).json({ message: 'Confirm your identity to continue.' });
    }
    if (result.kind === 'authorized') return res.status(201).json({ reauthId: result.reauthId });
    if (result.kind === 'disabled') return res.status(503).json({ message: result.message });
    if (result.kind === 'unauthorized') return res.status(401).json({ message: 'Your session expired. Please log in again.' });
    // invalid / invalid_password / password_unavailable / subject_mismatch: generic 400, keep input.
    return res.status(400).json({ message: result.message });
  } catch (error) {
    return next(error);
  }
});

// POST /api/auth/change-email  { reauthId, challengeId, newEmail }
// Atomically consumes BOTH the reauth proof and the verified new-email ownership challenge, then
// updates the email and rotates auth_version. Verifying/reauthenticating alone changes nothing.
router.post('/change-email', authenticate, async (req, res, next) => {
  try {
    const body = req.body ?? {};
    if (!body || typeof body !== 'object' || Array.isArray(body)
      || Object.keys(body).length !== CHANGE_EMAIL_FIELDS.size
      || Object.keys(body).some((field) => !CHANGE_EMAIL_FIELDS.has(field))) {
      return res.status(400).json({ message: 'Confirm the verification code to change your email.' });
    }
    const result = await changeEmail(req.userId, {
      reauthId: body.reauthId, challengeId: body.challengeId, newEmail: body.newEmail,
    });
    if (result.kind === 'changed') {
      // auth_version rotated: issue a fresh token so THIS client stays signed in while others are out.
      return res.json({ token: signToken(result.user), user: toPublicUser(result.user) });
    }
    if (result.kind === 'invalid_email') {
      const message = 'Enter a valid new email address.';
      return res.status(400).json({ message, errors: { newEmail: message } });
    }
    if (result.kind === 'duplicate_email') {
      const message = 'That email already has an account. Try another.';
      return res.status(409).json({ message, errors: { newEmail: message } });
    }
    if (result.kind === 'unauthorized') {
      return res.status(401).json({ message: 'Confirm your identity again to change your email.' });
    }
    // unverified: ownership challenge not verified/expired/consumed/mismatched.
    return res.status(409).json({ message: 'Verify your new email again to change it.' });
  } catch (error) {
    return next(error);
  }
});

// POST /api/auth/set-password  { reauthId, challengeId, newPassword }
// First-password setup for a Google-only account. Atomically consumes BOTH a Google reauth proof
// and a verified set_password email OTP, requires password_hash IS NULL, stores the hash, and
// rotates auth_version. Reauthenticating/verifying alone sets nothing.
router.post('/set-password', authenticate, async (req, res, next) => {
  try {
    const body = req.body ?? {};
    if (!body || typeof body !== 'object' || Array.isArray(body)
      || Object.keys(body).length !== SET_PASSWORD_FIELDS.size
      || Object.keys(body).some((field) => !SET_PASSWORD_FIELDS.has(field))) {
      return res.status(400).json({ message: 'Confirm the verification code and your new password.' });
    }
    const result = await setPassword(req.userId, {
      reauthId: body.reauthId, challengeId: body.challengeId, newPassword: body.newPassword,
    });
    if (result.kind === 'set') {
      // auth_version rotated: issue a fresh token so THIS device stays signed in while others are out.
      return res.json({ token: signToken(result.user), user: toPublicUser(result.user) });
    }
    if (result.kind === 'invalid_password') {
      return res.status(400).json({ message: result.message, errors: { newPassword: result.message } });
    }
    if (result.kind === 'password_exists') {
      return res.status(409).json({ message: 'This account already has a password. Use Change password instead.' });
    }
    if (result.kind === 'unauthorized') {
      return res.status(401).json({ message: 'Confirm your identity again to set a password.' });
    }
    // unverified: ownership challenge not verified/expired/consumed.
    return res.status(409).json({ message: 'Verify your email again to set a password.' });
  } catch (error) {
    return next(error);
  }
});

// GET /api/auth/recovery-config
router.get('/recovery-config', (_req, res) => res.json(recovery.config()));

// GET /api/auth/google-config
router.get('/google-config', (_req, res) => res.json(googleAuth.config()));

// POST /api/auth/google/nonce
router.post('/google/nonce', async (req, res, next) => {
  try {
    const body = req.body ?? {};
    const keys = Object.keys(body);
    // Only an explicit login/signup intent is accepted; anything else is rejected
    // so intent is always bound to the server-issued single-use attempt.
    if (keys.length !== 1 || keys[0] !== 'intent' || !GOOGLE_INTENTS.has(body.intent)) {
      return res.status(400).json({ message: 'Choose log in or sign up to continue with Google.' });
    }
    const result = await googleAuth.issueNonce({ intent: body.intent });
    if (result.kind === 'disabled') return res.status(503).json({ message: 'Google sign-in is not available right now.' });
    if (result.kind === 'invalid') return res.status(400).json({ message: 'Choose log in or sign up to continue with Google.' });
    return res.status(201).json(result);
  } catch (error) {
    return next(error);
  }
});

// POST /api/auth/google/authenticate
router.post('/google/authenticate', async (req, res, next) => {
  try {
    if (!hasExactFields(req.body, GOOGLE_AUTH_FIELDS)) {
      return res.status(400).json({ message: 'Google sign-in could not be completed.' });
    }
    const result = await googleAuth.authenticate(req.body);
    if (result.kind === 'authenticated') {
      return res.json({ token: signToken(result.user), user: toPublicUser(result.user) });
    }
    if (result.kind === 'signup_required' || result.kind === 'link_required'
      || result.kind === 'signup_needed' || result.kind === 'login_required') {
      return res.status(409).json(result);
    }
    return res.status(result.kind === 'disabled' ? 503 : 400).json({ message: result.message });
  } catch (error) {
    return next(error);
  }
});

// POST /api/auth/google/signup
router.post('/google/signup', async (req, res, next) => {
  try {
    if (!hasExactFields(req.body, GOOGLE_SIGNUP_FIELDS)) {
      return res.status(400).json({ message: 'Complete the required account details.' });
    }
    const result = await googleAuth.completeSignup(req.body);
    if (result.kind !== 'authenticated') {
      return res.status(result.kind === 'disabled' ? 503 : 400).json({ message: result.message });
    }
    return res.status(201).json({ token: signToken(result.user), user: toPublicUser(result.user) });
  } catch (error) {
    return next(error);
  }
});

// POST /api/auth/google/link
router.post('/google/link', async (req, res, next) => {
  try {
    if (!hasExactFields(req.body, GOOGLE_LINK_FIELDS)) {
      return res.status(400).json({ message: 'Confirm your password to link Google.' });
    }
    const result = await googleAuth.linkAccount(req.body);
    if (result.kind !== 'authenticated') {
      const body = { message: result.message };
      if (result.code === GOOGLE_LINK_RESTART_CODE) body.code = GOOGLE_LINK_RESTART_CODE;
      return res.status(result.kind === 'disabled' ? 503 : 400).json(body);
    }
    return res.json({ token: signToken(result.user), user: toPublicUser(result.user) });
  } catch (error) {
    return next(error);
  }
});

// POST /api/auth/forgot-password
router.post('/forgot-password', async (req, res, next) => {
  try {
    const body = req.body ?? {};
    const unknownField = Object.keys(body).find((field) => !FORGOT_PASSWORD_FIELDS.has(field));
    if (unknownField || Object.keys(body).length !== 1 || typeof body.email !== 'string') {
      return res.status(400).json({ message: 'Enter a valid email address.' });
    }
    if (!recovery.config().enabled) {
      return res.status(503).json({ message: 'Password recovery is not available right now. Please contact Cookie Fluffs support.' });
    }
    const startedAt = Date.now();
    const result = await recovery.requestReset(body.email, req.ip);
    const remainingDelay = Math.max(0, 150 - (Date.now() - startedAt));
    if (remainingDelay) await new Promise((resolve) => setTimeout(resolve, remainingDelay));
    res.status(202).json({ message: RECOVERY_GENERIC_MESSAGE });
    if (result.delivery) {
      setImmediate(() => recovery.deliverReset(result.delivery).catch(() => undefined));
    }
    return res;
  } catch (error) {
    return next(error);
  }
});

// POST /api/auth/reset-password
router.post('/reset-password', async (req, res, next) => {
  try {
    const body = req.body ?? {};
    const unknownField = Object.keys(body).find((field) => !RESET_PASSWORD_FIELDS.has(field));
    if (unknownField || Object.keys(body).length !== RESET_PASSWORD_FIELDS.size
      || typeof body.selector !== 'string' || typeof body.token !== 'string'
      || typeof body.newPassword !== 'string' || body.newPassword.length > 128
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.selector)
      || !/^[A-Za-z0-9_-]{43}$/.test(body.token)) {
      return res.status(400).json({ message: RECOVERY_INVALID_MESSAGE });
    }
    if (!recovery.config().enabled) {
      return res.status(503).json({ message: 'Password recovery is not available right now. Please contact Cookie Fluffs support.' });
    }
    const result = await recovery.resetPassword(body.selector, body.token, body.newPassword);
    if (result.kind === 'invalid') return res.status(400).json({ message: RECOVERY_INVALID_MESSAGE });
    if (result.kind === 'invalid_password') {
      return res.status(400).json({ message: result.message, errors: { newPassword: result.message } });
    }
    if (result.kind === 'reused') {
      const message = 'Choose a password that is different from your current password.';
      return res.status(400).json({ message, errors: { newPassword: message } });
    }
    return res.json({ message: 'Your password has been reset. Log in with your new password.' });
  } catch (error) {
    return next(error);
  }
});

  return router;
}

export default createAuthRouter();
