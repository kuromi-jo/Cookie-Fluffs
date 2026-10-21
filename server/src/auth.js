/**
 * @file auth.js
 * @description JWT helpers and the requireAuth middleware.
 */
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { splitFullName } from './validation.js';

const SECRET =
  process.env.JWT_SECRET ||
  (console.warn('[auth] JWT_SECRET missing in .env; using a temporary secret (logins reset on restart).'),
  crypto.randomBytes(32).toString('hex'));

export function signToken(userId) {
  return jwt.sign({ sub: userId }, SECRET, { expiresIn: '7d' });
}

/** Shapes a users row into what the app sees (never includes the password hash). */
export function toPublicUser(row) {
  const fallbackName = splitFullName(row.full_name);
  return {
    id: row.id,
    fullName: row.full_name,
    firstName: row.first_name ?? fallbackName.firstName,
    lastName: row.last_name ?? fallbackName.lastName,
    email: row.email,
    phone: row.phone,
    avatar: row.avatar,
    createdAt: row.created_at,
  };
}

/** Rejects the request unless it carries a valid "Bearer <token>" header. */
export function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ message: 'Please log in first.' });
  try {
    req.userId = Number(jwt.verify(token, SECRET).sub);
    next();
  } catch {
    res.status(401).json({ message: 'Your session expired. Please log in again.' });
  }
}

/** Attaches req.userId when a valid token is present, but never blocks. */
export function optionalAuth(req, _res, next) {
  const header = req.headers.authorization || '';
  if (header.startsWith('Bearer ')) {
    try {
      req.userId = Number(jwt.verify(header.slice(7), SECRET).sub);
    } catch {
      /* treat as guest */
    }
  }
  next();
}
