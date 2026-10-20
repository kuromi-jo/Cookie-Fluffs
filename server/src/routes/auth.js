/**
 * @file auth.js (routes)
 * @description Sign up, log in, and the current user's profile.
 */
import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { query } from '../db.js';
import { requireAuth, signToken, toPublicUser } from '../auth.js';

const router = Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_AVATAR_LENGTH = 400_000; // ~300 KB image as a data URL

function cleanAvatar(avatar) {
  if (!avatar) return null;
  if (typeof avatar !== 'string' || !avatar.startsWith('data:image/') || avatar.length > MAX_AVATAR_LENGTH) {
    const err = new Error('Profile photo must be an image under 300 KB.');
    err.status = 400;
    throw err;
  }
  return avatar;
}

// POST /api/auth/signup
router.post('/signup', async (req, res, next) => {
  try {
    const fullName = String(req.body.fullName || '').trim();
    const email = String(req.body.email || '').trim().toLowerCase();
    const phone = String(req.body.phone || '').trim();
    const password = String(req.body.password || '');
    const avatar = cleanAvatar(req.body.avatar);

    if (fullName.length < 2) return res.status(400).json({ message: 'Please enter your full name.' });
    if (!EMAIL_RE.test(email)) return res.status(400).json({ message: 'Please enter a valid email.' });
    if (!/^[0-9+\-\s()]{7,20}$/.test(phone)) return res.status(400).json({ message: 'Please enter a valid phone number.' });
    if (password.length < 6) return res.status(400).json({ message: 'Password needs at least 6 characters.' });

    const exists = await query('SELECT 1 FROM users WHERE email = $1', [email]);
    if (exists.rowCount) return res.status(409).json({ message: 'That email already has an account. Try logging in.' });

    const hash = await bcrypt.hash(password, 10);
    const { rows } = await query(
      `INSERT INTO users (full_name, email, phone, avatar, password_hash)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [fullName, email, phone, avatar, hash],
    );
    res.status(201).json({ token: signToken(rows[0].id), user: toPublicUser(rows[0]) });
  } catch (err) {
    next(err);
  }
});

// POST /api/auth/login
router.post('/login', async (req, res, next) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    const { rows } = await query('SELECT * FROM users WHERE email = $1', [email]);
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
    const { rows } = await query('SELECT * FROM users WHERE id = $1', [req.userId]);
    if (!rows.length) return res.status(401).json({ message: 'Account not found. Please log in again.' });
    res.json(toPublicUser(rows[0]));
  } catch (err) {
    next(err);
  }
});

// PUT /api/auth/me  (update name, phone, or photo)
router.put('/me', requireAuth, async (req, res, next) => {
  try {
    const fullName = req.body.fullName !== undefined ? String(req.body.fullName).trim() : undefined;
    const phone = req.body.phone !== undefined ? String(req.body.phone).trim() : undefined;
    const avatar = req.body.avatar !== undefined ? cleanAvatar(req.body.avatar) : undefined;

    if (fullName !== undefined && fullName.length < 2) return res.status(400).json({ message: 'Please enter your full name.' });
    if (phone !== undefined && !/^[0-9+\-\s()]{7,20}$/.test(phone)) return res.status(400).json({ message: 'Please enter a valid phone number.' });

    const { rows } = await query(
      `UPDATE users SET
         full_name = COALESCE($2, full_name),
         phone     = COALESCE($3, phone),
         avatar    = CASE WHEN $5 THEN $4 ELSE avatar END
       WHERE id = $1 RETURNING *`,
      [req.userId, fullName ?? null, phone ?? null, avatar ?? null, avatar !== undefined],
    );
    res.json(toPublicUser(rows[0]));
  } catch (err) {
    next(err);
  }
});

export default router;
