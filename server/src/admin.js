/**
 * @file admin.js
 * @description Superadmin access. The account with SUPERADMIN_EMAIL is the shop owner: it can open
 * the admin dashboard and move orders through fulfillment using the existing order-lifecycle rules.
 */
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { query } from './db.js';
import { requireAuth } from './auth.js';
import { requireJwtSecret } from './runtime-config.js';
import { authenticateOrderOperator, createOrderOperator } from './order-lifecycle.js';

export const SUPERADMIN_EMAIL = 'superadmin@gmail.com';
/** Hardcoded for easier testing (school demo). Logging in with this always works for the superadmin account. */
export const SUPERADMIN_TEST_PASSWORD = '123456';
const OPERATOR_META_KEY = 'superadmin_operator';

/**
 * Creates the superadmin account on first login with the test password, so the demo works on any database.
 * Returns the users row (existing or new).
 */
export async function ensureSuperadminAccount(dbQuery = query) {
  const passwordHash = await bcrypt.hash(SUPERADMIN_TEST_PASSWORD, 10);
  const { rows } = await dbQuery(
    `INSERT INTO users (full_name, first_name, last_name, email, phone, password_hash)
     VALUES ('Shop Admin', 'Shop', 'Admin', $1, '+639000000000', $2)
     ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email
     RETURNING *`,
    [SUPERADMIN_EMAIL, passwordHash],
  );
  return rows[0];
}

/** True when the user id belongs to the superadmin account. */
export async function isSuperAdmin(userId, dbQuery = query) {
  if (!userId) return false;
  const { rows } = await dbQuery('SELECT lower(email) AS email FROM users WHERE id = $1', [userId]);
  return rows[0]?.email === SUPERADMIN_EMAIL;
}

/** requireAuth, then rejects anyone who is not the superadmin. */
export function requireSuperAdmin(req, res, next) {
  requireAuth(req, res, async (err) => {
    if (err) return next(err);
    try {
      if (!(await isSuperAdmin(req.userId))) return res.status(403).json({ message: 'Only the shop admin can do that.' });
      next();
    } catch (error) {
      next(error);
    }
  });
}

/** A stable operator secret derived from the server secret, so nothing extra is stored or configured. */
function operatorCredential() {
  return crypto.createHmac('sha256', requireJwtSecret()).update('cookie-fluffs-superadmin-operator').digest('base64url');
}

/**
 * The order operator identity the superadmin acts as. Created on first use and remembered in app_meta,
 * so admin status changes go through the same audited advanceOrderStatus / resolveCancellationRequest code.
 */
export async function superadminOperator(client) {
  const credential = operatorCredential();
  const saved = await client.query('SELECT value FROM app_meta WHERE key = $1', [OPERATOR_META_KEY]);
  const id = saved.rows[0]?.value;
  if (id) {
    try {
      await authenticateOrderOperator(client, id, credential);
      return { id, credential };
    } catch {
      /* revoked or secret changed: create a fresh operator below */
    }
  }
  const operator = await createOrderOperator(client, 'Shop admin', credential);
  await client.query(
    `INSERT INTO app_meta (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [OPERATOR_META_KEY, operator.id],
  );
  return { id: operator.id, credential };
}
