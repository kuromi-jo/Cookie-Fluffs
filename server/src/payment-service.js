/**
 * @file payment-service.js
 * @description Durable, owner-scoped Hosted Checkout session creation and recovery.
 */
import crypto from 'node:crypto';
import { ONLINE_PAYMENT_METHODS } from './payment-config.js';
import { moneyToCentavos } from './pricing.js';

const httpError = (status, message, code) => Object.assign(new Error(message), { status, ...(code ? { code } : {}) });

function paymentResponse(row) {
  return {
    attemptId: row.publicId,
    checkoutUrl: row.checkoutUrl,
    status: row.status,
  };
}

function intentResponse(row, intent) {
  return {
    flow: 'payment_intent',
    attemptId: row.publicId,
    paymentIntentId: intent.paymentIntentId,
    clientKey: intent.clientKey,
    status: intent.status,
    ...(intent.status === 'awaiting_next_action' && typeof intent.authorizationUrl === 'string'
      ? { authorizationUrl: intent.authorizationUrl }
      : {}),
  };
}

async function loadPaymentOrder(client, userId, publicId) {
  const result = await client.query(
    `SELECT id AS "internalId", public_id AS id,
            COALESCE(payment_method_v2, payment_method) AS "paymentMethod",
            COALESCE(payment_state, payment_status) AS "paymentStatus",
            payment_is_demo AS "paymentIsDemo",
            order_total::text AS total, currency
     FROM orders WHERE user_id = $1 AND public_id = $2 FOR UPDATE`,
    [userId, publicId],
  );
  return result.rows[0] ?? null;
}

export async function createOrReusePaymentSession(client, userId, orderId, idempotencyKey, adapter) {
  let attempt;
  let order;
  await client.query('BEGIN');
  try {
    order = await loadPaymentOrder(client, userId, orderId);
    if (!order) throw httpError(404, 'Order not found.');
    if (order.paymentIsDemo) throw httpError(409, 'This demonstration order cannot use a genuine payment provider.');
    if (!ONLINE_PAYMENT_METHODS[order.paymentMethod]) throw httpError(409, 'This order does not use online payment.');
    if (order.paymentStatus === 'paid') throw httpError(409, 'This order is already paid.');

    const existing = await client.query(
      `SELECT public_id AS "publicId", checkout_url AS "checkoutUrl", status, idempotency_key AS "idempotencyKey"
       FROM payment_attempts
       WHERE order_id = $1 AND (idempotency_key = $2 OR status IN ('creating', 'active', 'processing'))
       ORDER BY CASE WHEN status IN ('creating', 'active', 'processing') THEN 0 ELSE 1 END,
                created_at DESC
       LIMIT 1 FOR UPDATE`,
      [order.internalId, idempotencyKey],
    );
    if (existing.rowCount) {
      attempt = existing.rows[0];
      if (attempt.status === 'expired'
        || (!attempt.checkoutUrl && ['failed', 'cancelled'].includes(attempt.status))) {
        throw httpError(410, 'This secure payment session expired. Start a new payment session.');
      }
      if (attempt.checkoutUrl) {
        await client.query('COMMIT');
        return paymentResponse(attempt);
      }
    } else {
      const method = ONLINE_PAYMENT_METHODS[order.paymentMethod];
      const result = await client.query(
        `INSERT INTO payment_attempts
           (public_id, order_id, provider, payment_method, provider_method, idempotency_key,
            amount_centavos, currency, status)
         VALUES ($1, $2, 'paymongo', $3, $4, $5, $6, 'PHP', 'creating')
         RETURNING public_id AS "publicId", checkout_url AS "checkoutUrl", status,
                   idempotency_key AS "idempotencyKey"`,
        [crypto.randomUUID(), order.internalId, method.id, method.providerId, idempotencyKey, moneyToCentavos(order.total)],
      );
      attempt = result.rows[0];
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  }

  const session = await adapter.createCheckoutSession({
    attemptId: attempt.publicId,
    idempotencyKey: attempt.idempotencyKey,
    order,
  });

  await client.query('BEGIN');
  try {
    const saved = await client.query(
      `UPDATE payment_attempts
       SET provider_session_id = COALESCE(provider_session_id, $2),
           checkout_url = COALESCE(checkout_url, $3), status = 'active', updated_at = now()
       WHERE public_id = $1 AND status IN ('creating', 'active')
       RETURNING public_id AS "publicId", checkout_url AS "checkoutUrl", status`,
      [attempt.publicId, session.sessionId, session.checkoutUrl],
    );
    if (!saved.rowCount) throw httpError(409, 'This payment attempt can no longer be used.');
    await client.query(
      `UPDATE orders SET payment_state = 'awaiting_payment', updated_at = now()
       WHERE id = $1 AND payment_state <> 'paid'`,
      [order.internalId],
    );
    await client.query('COMMIT');
    return paymentResponse(saved.rows[0]);
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  }
}

export async function createOrReusePaymentIntent(client, userId, orderId, idempotencyKey, adapter) {
  let attempt;
  let order;
  await client.query('BEGIN');
  try {
    order = await loadPaymentOrder(client, userId, orderId);
    if (!order) throw httpError(404, 'Order not found.');
    if (order.paymentIsDemo) throw httpError(409, 'This demonstration order cannot use a genuine payment provider.');
    if (!ONLINE_PAYMENT_METHODS[order.paymentMethod]) throw httpError(409, 'This order does not use online payment.');
    if (order.paymentMethod === 'card') throw httpError(409, 'Card payment is unavailable pending a compliance review.');
    if (order.paymentStatus === 'paid') throw httpError(409, 'This order is already paid.');
    const existing = await client.query(
      `SELECT id AS "internalId", public_id AS "publicId", flow_type AS "flowType",
              provider_intent_id AS "paymentIntentId", checkout_url AS "checkoutUrl", status,
              idempotency_key AS "idempotencyKey"
       FROM payment_attempts
       WHERE order_id = $1
         AND (idempotency_key = $2 OR status IN ('creating', 'active', 'processing', 'failed'))
       ORDER BY CASE
                  WHEN status IN ('creating', 'active', 'processing') THEN 0
                  WHEN idempotency_key = $2 THEN 1
                  ELSE 2
                END,
                created_at DESC
       LIMIT 1 FOR UPDATE`,
      [order.internalId, idempotencyKey],
    );
    if (existing.rowCount) {
      attempt = existing.rows[0];
      if (attempt.flowType === 'hosted_checkout') {
        if (attempt.checkoutUrl) {
          await client.query('COMMIT');
          return { flow: 'hosted_checkout', ...paymentResponse(attempt) };
        }
        throw httpError(409, 'This order has an unfinished legacy payment attempt.');
      }
      if (['expired', 'cancelled'].includes(attempt.status)) {
        throw httpError(410, 'This payment attempt ended. Start a new payment attempt.');
      }
    } else {
      const method = ONLINE_PAYMENT_METHODS[order.paymentMethod];
      const result = await client.query(
        `INSERT INTO payment_attempts
           (public_id, order_id, provider, payment_method, provider_method, idempotency_key,
            amount_centavos, currency, status, flow_type)
         VALUES ($1, $2, 'paymongo', $3, $4, $5, $6, 'PHP', 'creating', 'payment_intent')
         RETURNING public_id AS "publicId", provider_intent_id AS "paymentIntentId", status,
                   idempotency_key AS "idempotencyKey"`,
        [crypto.randomUUID(), order.internalId, method.id, method.providerId, idempotencyKey, moneyToCentavos(order.total)],
      );
      attempt = result.rows[0];
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  }

  let intent = attempt.paymentIntentId
    ? await adapter.retrievePaymentIntent(attempt.paymentIntentId)
    : await adapter.createPaymentIntent({ attemptId: attempt.publicId, idempotencyKey: attempt.idempotencyKey, order });

  if (attempt.status === 'failed' && intent.status !== 'succeeded') {
    if (['awaiting_next_action', 'processing'].includes(intent.status)) {
      return intentResponse(attempt, intent);
    }
    if (intent.status !== 'awaiting_payment_method') {
      throw httpError(409, 'This payment attempt cannot be retried until its status is confirmed.');
    }
    if (attempt.idempotencyKey === idempotencyKey) {
      throw httpError(
        410,
        'This payment attempt failed. Start a new payment attempt for the same order.',
        'PAYMENT_ATTEMPT_FAILED',
      );
    }

    await client.query('BEGIN');
    try {
      order = await loadPaymentOrder(client, userId, orderId);
      if (!order) throw httpError(404, 'Order not found.');
      if (order.paymentStatus === 'paid') throw httpError(409, 'This order is already paid.');
      const open = await client.query(
        `SELECT id AS "internalId", public_id AS "publicId", flow_type AS "flowType",
                provider_intent_id AS "paymentIntentId", checkout_url AS "checkoutUrl", status,
                idempotency_key AS "idempotencyKey"
         FROM payment_attempts
         WHERE order_id = $1 AND status IN ('creating', 'active', 'processing')
         ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
        [order.internalId],
      );
      if (open.rowCount) {
        attempt = open.rows[0];
      } else {
        const method = ONLINE_PAYMENT_METHODS[order.paymentMethod];
        const result = await client.query(
          `INSERT INTO payment_attempts
             (public_id, order_id, provider, payment_method, provider_method, idempotency_key,
              amount_centavos, currency, status, flow_type)
           VALUES ($1, $2, 'paymongo', $3, $4, $5, $6, 'PHP', 'creating', 'payment_intent')
           RETURNING id AS "internalId", public_id AS "publicId", provider_intent_id AS "paymentIntentId",
                     status, idempotency_key AS "idempotencyKey"`,
          [crypto.randomUUID(), order.internalId, method.id, method.providerId, idempotencyKey, moneyToCentavos(order.total)],
        );
        attempt = result.rows[0];
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    }

    intent = attempt.paymentIntentId
      ? await adapter.retrievePaymentIntent(attempt.paymentIntentId)
      : await adapter.createPaymentIntent({ attemptId: attempt.publicId, idempotencyKey: attempt.idempotencyKey, order });
  }

  await client.query('BEGIN');
  try {
    const allowedStatuses = intent.status === 'succeeded'
      ? "('creating', 'active', 'processing', 'failed')"
      : "('creating', 'active', 'processing')";
    const saved = await client.query(
      `UPDATE payment_attempts
       SET provider_intent_id = COALESCE(provider_intent_id, $2), status = 'active', updated_at = now()
       WHERE public_id = $1 AND flow_type = 'payment_intent' AND status IN ${allowedStatuses}
       RETURNING public_id AS "publicId", provider_intent_id AS "paymentIntentId", status,
                 amount_centavos AS "amountCentavos", currency, provider_method AS "providerMethod"`,
      [attempt.publicId, intent.paymentIntentId],
    );
    if (!saved.rowCount || saved.rows[0].paymentIntentId !== intent.paymentIntentId) {
      throw httpError(409, 'This payment attempt can no longer be used.');
    }
    if (intent.status === 'succeeded') {
      const payment = intent.payment;
      const row = saved.rows[0];
      if (typeof payment?.id !== 'string' || !payment.id.startsWith('pay_')
        || Number(row.amountCentavos) !== payment.amount || row.currency !== payment.currency
        || row.providerMethod !== payment.sourceType) {
        throw httpError(409, 'Verified payment details do not match this order.');
      }
      await client.query(
        `UPDATE payment_attempts SET provider_payment_id = $2, status = 'paid', updated_at = now() WHERE public_id = $1`,
        [attempt.publicId, payment.id],
      );
      await client.query(
        `UPDATE orders SET payment_status = 'paid', payment_state = 'paid', updated_at = now()
         WHERE id = $1 AND COALESCE(payment_state, payment_status) <> 'refunded'`,
        [order.internalId],
      );
    }
    await client.query(
      `UPDATE orders SET payment_state = 'awaiting_payment', updated_at = now()
       WHERE id = $1 AND payment_state <> 'paid'`,
      [order.internalId],
    );
    await client.query('COMMIT');
    return intentResponse(saved.rows[0], intent);
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  }
}
