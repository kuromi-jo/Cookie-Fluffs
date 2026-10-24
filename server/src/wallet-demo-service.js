/**
 * @file wallet-demo-service.js
 * @description Transactional, financially isolated GCash and Maya demonstration processing.
 */
import crypto from 'node:crypto';
import { moneyToCentavos } from './pricing.js';

const WALLET_METHODS = new Set(['gcash', 'maya']);
const OUTCOMES = Object.freeze({ confirm: 'demo_approved', cancel: 'demo_cancelled' });
const httpError = (status, message) => Object.assign(new Error(message), { status });

function response(row) {
  return {
    attemptId: row.publicId,
    walletMethod: row.walletMethod,
    status: row.status,
    isDemo: true,
  };
}

export async function processDemoWallet(client, userId, orderId, idempotencyKey, action, config) {
  if (!config?.enabled || config.production) throw httpError(404, 'Wallet demo is unavailable.');
  const outcome = OUTCOMES[action];
  if (!outcome) throw httpError(400, 'Choose a valid wallet demo action.');

  await client.query('BEGIN');
  try {
    const orderResult = await client.query(
      `SELECT id, payment_is_demo AS "paymentIsDemo",
              COALESCE(payment_method_v2, payment_method) AS "paymentMethod",
              COALESCE(payment_state, payment_status) AS "paymentStatus",
              order_total::text AS total, currency
       FROM orders WHERE user_id = $1 AND public_id = $2 FOR UPDATE`,
      [userId, orderId],
    );
    if (!orderResult.rowCount) throw httpError(404, 'Order not found.');
    const order = orderResult.rows[0];
    if (!order.paymentIsDemo || !WALLET_METHODS.has(order.paymentMethod)) {
      throw httpError(409, 'This order does not use the wallet demo.');
    }
    if (['paid', 'refunded'].includes(order.paymentStatus)) {
      throw httpError(409, 'This order has a genuine financial settlement and cannot use the wallet demo.');
    }
    if (order.currency !== 'PHP') throw httpError(409, 'This order currency cannot use the wallet demo.');

    const existing = await client.query(
      `SELECT public_id AS "publicId", wallet_method AS "walletMethod", outcome AS status
       FROM wallet_demo_attempts
       WHERE order_id = $1 AND idempotency_key = $2 FOR UPDATE`,
      [order.id, idempotencyKey],
    );
    if (existing.rowCount) {
      if (existing.rows[0].status !== outcome) {
        throw httpError(409, 'That wallet demo key was already used for a different action.');
      }
      await client.query('COMMIT');
      return response(existing.rows[0]);
    }

    const approved = await client.query(
      `SELECT public_id AS "publicId", wallet_method AS "walletMethod", outcome AS status
       FROM wallet_demo_attempts
       WHERE order_id = $1 AND outcome = 'demo_approved'
       ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
      [order.id],
    );
    if (approved.rowCount) {
      await client.query('COMMIT');
      return response(approved.rows[0]);
    }

    const inserted = await client.query(
      `INSERT INTO wallet_demo_attempts
         (public_id, order_id, wallet_method, idempotency_key, amount_centavos, currency, outcome)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING public_id AS "publicId", wallet_method AS "walletMethod", outcome AS status`,
      [crypto.randomUUID(), order.id, order.paymentMethod, idempotencyKey, moneyToCentavos(order.total), order.currency, outcome],
    );
    await client.query('COMMIT');
    return response(inserted.rows[0]);
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  }
}
