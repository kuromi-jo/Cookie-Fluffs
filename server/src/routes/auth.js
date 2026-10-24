/**
 * @file auth.js (routes)
 * @description Sign up, log in, and the current user's profile.
 */
import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { query } from '../db.js';
import { requireAuth, signToken, toPublicUser } from '../auth.js';
import {
  joinName,
  normalizePhone,
  splitFullName,
  validateEmail,
  validateFirstName,
  validateFullName,
  validateLastName,
  validatePassword,
  validatePhone,
} from '../validation.js';

const MAX_AVATAR_LENGTH = 400_000; // ~300 KB image as a data URL
const AVATAR_ERROR = 'Profile photo must be an image under 300 KB.';
const DUPLICATE_EMAIL_ERROR = 'That email already has an account. Try logging in.';
const PROFILE_FIELDS = new Set(['firstName', 'lastName', 'phone', 'avatar']);

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

export function createAuthRouter(dbQuery = query) {
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
      res.status(201).json({ token: signToken(rows[0].id), user: toPublicUser(rows[0]) });
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
    const ok = rows.length && (await bcrypt.compare(password, rows[0].password_hash));
    if (!ok) return res.status(401).json({ message: 'Wrong email or password.' });
    res.json({ token: signToken(rows[0].id), user: toPublicUser(rows[0]) });
  } catch (err) {
    next(err);
  }
});

// GET /api/auth/me
router.get('/me', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await dbQuery('SELECT * FROM users WHERE id = $1', [req.userId]);
    if (!rows.length) return res.status(401).json({ message: 'Account not found. Please log in again.' });
    res.json(toPublicUser(rows[0]));
  } catch (err) {
    next(err);
  }
});

// PUT /api/auth/me  (update first name, last name, phone, or photo)
router.put('/me', requireAuth, async (req, res, next) => {
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
         avatar     = CASE WHEN $7 THEN $6 ELSE avatar END
       WHERE id = $1 RETURNING *`,
      [
        req.userId,
        mergedFirstName,
        mergedLastName,
        joinName(mergedFirstName, mergedLastName),
        normalizedPhone ?? null,
        avatar ?? null,
        avatar !== undefined,
      ],
    );
    res.json(toPublicUser(rows[0]));
  } catch (err) {
    next(err);
  }
});

  return router;
}

export default createAuthRouter();
