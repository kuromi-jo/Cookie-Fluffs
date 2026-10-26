/**
 * @file auth.js
 * @description JWT helpers and the requireAuth middleware.
 */
import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';
import { query } from './db.js';
import { splitFullName } from './validation.js';
import { requireJwtSecret } from './runtime-config.js';

export const JWT_ISSUER = 'cookie-fluffs-api';
export const JWT_AUDIENCE = 'cookie-fluffs-app';

export function signToken(userOrId, authVersion = undefined) {
  const userId = typeof userOrId === 'object' ? userOrId.id : userOrId;
  const version = authVersion ?? (typeof userOrId === 'object' ? userOrId.auth_version : 1) ?? 1;
  return jwt.sign(
    { auth_version: Number(version) },
    requireJwtSecret(),
    {
      algorithm: 'HS256',
      subject: String(userId),
      jwtid: crypto.randomUUID(),
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
      expiresIn: '7d',
    },
  );
}

/** Shapes a users row into what the app sees (never includes the password hash). */
/**
 * Formats a DATE-only value as YYYY-MM-DD. node-postgres returns a DATE as a JS Date at
 * local midnight, so we read local components (not UTC) to avoid a timezone off-by-one.
 */
function formatDateOnly(value) {
  if (!value) return null;
  if (value instanceof Date) {
    const year = value.getFullYear();
    const month = String(value.getMonth() + 1).padStart(2, '0');
    const day = String(value.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }
  return String(value).slice(0, 10);
}

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
    gender: row.gender ?? null,
    dateOfBirth: formatDateOnly(row.date_of_birth),
    hasPassword: Boolean(row.password_hash),
    createdAt: row.created_at,
  };
}

/** Rejects the request unless it carries a valid "Bearer <token>" header. */
function verifiedClaims(token) {
  const claims = jwt.verify(token, requireJwtSecret(), {
    algorithms: ['HS256'],
    issuer: JWT_ISSUER,
    audience: JWT_AUDIENCE,
  });
  const userId = Number(claims.sub);
  const authVersion = Number(claims.auth_version);
  if (!Number.isSafeInteger(userId) || userId < 1 || !Number.isSafeInteger(authVersion) || authVersion < 1
    || typeof claims.jti !== 'string' || !/^[0-9a-f-]{36}$/i.test(claims.jti)) {
    throw new Error('Invalid session claims.');
  }
  return { userId, authVersion };
}

/** Builds middleware that verifies the signed token against the current account row. */
export function createRequireAuth(dbQuery = query) {
  return async (req, res, next) => {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return res.status(401).json({ message: 'Please log in first.' });
    let claims;
    try {
      claims = verifiedClaims(token);
    } catch {
      return res.status(401).json({ message: 'Your session expired. Please log in again.' });
    }
    try {
      const { rows } = await dbQuery(
        'SELECT id, auth_version, account_status FROM users WHERE id = $1',
        [claims.userId],
      );
      const user = rows[0];
      if (!user || user.account_status !== 'active' || Number(user.auth_version) !== claims.authVersion) {
        return res.status(401).json({ message: 'Your session expired. Please log in again.' });
      }
      req.userId = claims.userId;
      req.authVersion = claims.authVersion;
      return next();
    } catch (error) {
      return next(error);
    }
  };
}

export const requireAuth = createRequireAuth();

/** Attaches req.userId for a current active session, but continues as guest otherwise. */
export function createOptionalAuth(dbQuery = query) {
  const authenticate = createRequireAuth(dbQuery);
  return async (req, _res, next) => {
    const guestResponse = { status: () => guestResponse, json: () => next() };
    return authenticate(req, guestResponse, next);
  };
}

export const optionalAuth = createOptionalAuth();
