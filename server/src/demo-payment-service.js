/**
 * @file demo-payment-service.js
 * @description Transactional, financially isolated card-demo outcome processing.
 */
import crypto from 'node:crypto';
import { moneyToCentavos } from './pricing.js';

export const DEMO_CARD_SCENARIOS = Object.freeze({
  visa_approved: 'demo_approved',
  mastercard_declined: 'demo_declined',
});

const httpError = (status, message) => Object.assign(new Error(message), { status });

function response(row) {
  return {
    attemptId: row.publicId,
    scenario: row.scenario,
    status: row.status,
    isDemo: true,
  };
}

export async function processDemoCard(client, userId, orderId, idempotencyKey, scenario, config) {
  if (!config?.enabled || config.production) {
    throw httpError(404, 'Card demo is unavailable.');
  }
  const outcome = DEMO_CARD_SCENARIOS[scenario];
  if (!outcome) throw httpError(400, 'Choose an approved card demo scenario.');

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
    if (!order.paymentIsDemo || order.paymentMethod !== 'card') {
      throw httpError(409, 'This order does not use the card demo.');
    }
    if (['paid', 'refunded'].includes(order.paymentStatus)) {
      throw httpError(409, 'This order has a genuine financial settlement and cannot use the card demo.');
    }

    const existing = await client.query(
      `SELECT public_id AS "publicId", scenario, status
       FROM demo_payment_attempts
       WHERE order_id = $1 AND idempotency_key = $2 FOR UPDATE`,
      [order.id, idempotencyKey],
    );
    if (existing.rowCount) {
      if (existing.rows[0].scenario !== scenario) {
        throw httpError(409, 'That demo payment key was already used with a different scenario.');
      }
      await client.query('COMMIT');
      return response(existing.rows[0]);
    }

    const approved = await client.query(
      `SELECT public_id AS "publicId", scenario, status
       FROM demo_payment_attempts
       WHERE order_id = $1 AND status = 'demo_approved'
       ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
      [order.id],
    );
    if (approved.rowCount) {
      await client.query('COMMIT');
      return response(approved.rows[0]);
    }

    const inserted = await client.query(
      `INSERT INTO demo_payment_attempts
         (public_id, order_id, scenario, idempotency_key, amount_centavos, currency, status)
       VALUES ($1, $2, $3, $4, $5, 'PHP', $6)
       RETURNING public_id AS "publicId", scenario, status`,
      [crypto.randomUUID(), order.id, scenario, idempotencyKey, moneyToCentavos(order.total), outcome],
    );
    await client.query('COMMIT');
    return response(inserted.rows[0]);
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  }
}
