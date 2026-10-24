/**
 * @file payment-webhook.js
 * @description PayMongo signature verification, event parsing, deduplication, and paid-order reconciliation.
 */
import crypto from 'node:crypto';
import { ONLINE_PAYMENT_METHODS } from './payment-config.js';
import { ensureRefundReview } from './refund-service.js';

const httpError = (status, message) => Object.assign(new Error(message), { status });

function matchingTerminalState(attempt, providerPaymentId, status) {
  const attemptMatches = attempt.status === status;
  const orderMatches = attempt.paymentStatus === status;
  if (!attemptMatches && !orderMatches) return false;
  if (attemptMatches && orderMatches && attempt.providerPaymentId === providerPaymentId) return true;
  if (attempt.providerPaymentId && attempt.providerPaymentId !== providerPaymentId) {
    throw httpError(409, 'A different provider payment is already recorded.');
  }
  throw httpError(409, 'Payment state does not match this notification.');
}

function markEventProcessed(client, eventId) {
  return client.query(
    `UPDATE payment_webhook_events SET processed_at = now()
     WHERE provider = 'paymongo' AND event_id = $1`,
    [eventId],
  );
}

function timingSafeHexEqual(left, right) {
  if (!/^[0-9a-f]+$/i.test(left) || !/^[0-9a-f]+$/i.test(right) || left.length !== right.length) return false;
  return crypto.timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

export function verifyPaymongoSignature(rawBody, header, secret, nowSeconds = Math.floor(Date.now() / 1000), tolerance = 300) {
  if (!Buffer.isBuffer(rawBody) || typeof header !== 'string' || !secret) return false;
  const values = Object.fromEntries(header.split(',').map((part) => part.trim().split('=', 2)));
  const timestamp = Number(values.t);
  if (!Number.isSafeInteger(timestamp) || Math.abs(nowSeconds - timestamp) > tolerance || !values.te) return false;
  const expected = crypto.createHmac('sha256', secret).update(`${values.t}.`).update(rawBody).digest('hex');
  return timingSafeHexEqual(expected, values.te);
}

export function parsePaymongoEvent(payload, rawBody) {
  const generic = payload?.data?.type === 'event' ? payload.data : null;
  const attributes = generic?.attributes ?? payload?.data;
  const eventType = attributes?.type;
  const session = attributes?.data;
  const livemode = attributes?.livemode;
  const eventId = generic?.id ?? `evt_sha256_${crypto.createHash('sha256').update(rawBody).digest('hex')}`;
  if (typeof eventId !== 'string' || typeof eventType !== 'string' || typeof livemode !== 'boolean') {
    throw httpError(400, 'Invalid payment event.');
  }
  return { eventId, eventType, livemode, session };
}

export async function reconcilePaymongoEvent(client, event, payloadHash) {
  await client.query('BEGIN');
  try {
    const inserted = await client.query(
      `INSERT INTO payment_webhook_events (provider, event_id, event_type, payload_hash, livemode)
       VALUES ('paymongo', $1, $2, $3, $4)
       ON CONFLICT (provider, event_id) DO NOTHING RETURNING event_id`,
      [event.eventId, event.eventType, payloadHash, event.livemode],
    );
    if (!inserted.rowCount) {
      await client.query('COMMIT');
      return { duplicate: true, processed: false };
    }
    if (event.livemode) throw httpError(400, 'Live payment events are disabled.');
    if (event.eventType === 'payment.paid' || event.eventType === 'payment.failed') {
      const payment = event.session;
      const attributes = payment?.attributes;
      const intentId = attributes?.payment_intent_id;
      if (typeof payment?.id !== 'string' || !payment.id.startsWith('pay_')
        || typeof intentId !== 'string' || !intentId.startsWith('pi_')) {
        throw httpError(400, 'Invalid payment event.');
      }
      const result = await client.query(
        `SELECT pa.id, pa.payment_method AS "paymentMethod", pa.provider_method AS "providerMethod",
                pa.amount_centavos AS "amountCentavos", pa.currency, pa.status,
                pa.provider_payment_id AS "providerPaymentId", o.id AS "orderId",
                COALESCE(o.payment_state, o.payment_status) AS "paymentStatus"
         FROM payment_attempts pa JOIN orders o ON o.id = pa.order_id
         WHERE pa.provider_intent_id = $1 FOR UPDATE OF pa, o`,
        [intentId],
      );
      if (!result.rowCount) throw httpError(400, 'Payment details do not match an order.');
      const attempt = result.rows[0];
      const sourceType = attributes.source?.type;
      if (Number(attempt.amountCentavos) !== attributes.amount || attempt.currency !== attributes.currency
        || attempt.providerMethod !== sourceType) {
        throw httpError(400, 'Payment amount, currency, or method does not match the order.');
      }
      if (event.eventType === 'payment.paid') {
        const alreadySettled = matchingTerminalState(attempt, payment.id, 'paid');
        if (!alreadySettled) {
          if (['expired', 'cancelled'].includes(attempt.status)) throw httpError(409, 'This payment attempt is no longer active.');
          if (attempt.providerPaymentId && attempt.providerPaymentId !== payment.id) {
            throw httpError(409, 'A different provider payment is already recorded.');
          }
          await client.query(
            `UPDATE payment_attempts SET provider_payment_id = $2, status = 'paid', updated_at = now() WHERE id = $1`,
            [attempt.id, payment.id],
          );
          await client.query(
            `UPDATE orders SET payment_status = 'paid', payment_state = 'paid', updated_at = now()
             WHERE id = $1 AND COALESCE(payment_state, payment_status) <> 'refunded'`,
            [attempt.orderId],
          );
          await ensureRefundReview(client, attempt.orderId);
        }
      } else {
        const alreadyPaid = matchingTerminalState(attempt, payment.id, 'paid');
        const alreadyFailed = alreadyPaid ? false : matchingTerminalState(attempt, payment.id, 'failed');
        if (!alreadyPaid && !alreadyFailed) {
          if (['expired', 'cancelled'].includes(attempt.status)) throw httpError(409, 'This payment attempt is no longer active.');
          if (attempt.providerPaymentId && attempt.providerPaymentId !== payment.id) {
            throw httpError(409, 'A different provider payment is already recorded.');
          }
          await client.query(
            `UPDATE payment_attempts
             SET provider_payment_id = $2, status = 'failed', updated_at = now()
             WHERE id = $1`,
            [attempt.id, payment.id],
          );
          await client.query(
            `UPDATE orders SET payment_state = 'failed', updated_at = now()
             WHERE id = $1 AND COALESCE(payment_state, payment_status) NOT IN ('paid', 'refunded')`,
            [attempt.orderId],
          );
        }
      }
      await markEventProcessed(client, event.eventId);
      await client.query('COMMIT');
      return { duplicate: false, processed: true };
    }
    if (event.eventType !== 'checkout_session.payment.paid') {
      await client.query(
        `UPDATE payment_webhook_events SET processed_at = now()
         WHERE provider = 'paymongo' AND event_id = $1`,
        [event.eventId],
      );
      await client.query('COMMIT');
      return { duplicate: false, processed: false };
    }

    const session = event.session;
    const attributes = session?.attributes;
    const paidPayments = Array.isArray(attributes?.payments)
      ? attributes.payments.filter((payment) => payment?.attributes?.status === 'paid')
      : [];
    const payment = paidPayments[0];
    if (typeof session?.id !== 'string' || !session.id.startsWith('cs_') || paidPayments.length !== 1
      || typeof payment?.id !== 'string' || !payment.id.startsWith('pay_')) {
      throw httpError(400, 'Invalid paid checkout event.');
    }
    const reference = attributes.reference_number;
    const amount = payment.attributes.amount;
    const currency = payment.attributes.currency;
    if (typeof reference !== 'string' || !Number.isSafeInteger(amount) || amount <= 0 || currency !== 'PHP') {
      throw httpError(400, 'Payment details do not match an order.');
    }

    const orderResult = await client.query(
      `SELECT id, COALESCE(payment_method_v2, payment_method) AS "paymentMethod",
              COALESCE(payment_state, payment_status) AS "paymentStatus"
       FROM orders WHERE public_id = $1 FOR UPDATE`,
      [reference],
    );
    if (!orderResult.rowCount) throw httpError(400, 'Payment details do not match an order.');
    const order = orderResult.rows[0];
    const attemptResult = await client.query(
      `SELECT id, payment_method AS "paymentMethod", provider_method AS "providerMethod",
              amount_centavos AS "amountCentavos", currency, status,
              provider_payment_id AS "providerPaymentId"
       FROM payment_attempts WHERE order_id = $1 AND provider_session_id = $2 FOR UPDATE`,
      [order.id, session.id],
    );
    if (!attemptResult.rowCount) throw httpError(400, 'Payment details do not match an order.');
    const attempt = attemptResult.rows[0];
    attempt.paymentStatus = order.paymentStatus;
    const expectedProvider = ONLINE_PAYMENT_METHODS[order.paymentMethod]?.providerId;
    const sourceType = payment.attributes.source?.type;
    if (Number(attempt.amountCentavos) !== amount || attempt.currency !== currency
      || attempt.providerMethod !== expectedProvider || sourceType !== expectedProvider) {
      throw httpError(400, 'Payment amount, currency, or method does not match the order.');
    }
    const alreadySettled = matchingTerminalState(attempt, payment.id, 'paid');
    if (!alreadySettled) {
      if (['expired', 'cancelled'].includes(attempt.status)) {
        throw httpError(409, 'This payment attempt is no longer active.');
      }
      await client.query(
        `UPDATE payment_attempts
         SET provider_payment_id = $2, status = 'paid', updated_at = now()
         WHERE id = $1`,
        [attempt.id, payment.id],
      );
      await client.query(
        `UPDATE orders SET payment_status = 'paid', payment_state = 'paid', updated_at = now()
         WHERE id = $1 AND COALESCE(payment_state, payment_status) <> 'refunded'`,
        [order.id],
      );
      await ensureRefundReview(client, order.id);
    }
    await markEventProcessed(client, event.eventId);
    await client.query('COMMIT');
    return { duplicate: false, processed: true };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  }
}
