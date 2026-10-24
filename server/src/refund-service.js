/**
 * @file refund-service.js
 * @description Internal refund eligibility, review creation, and customer-safe snapshots.
 */
import crypto from 'node:crypto';
import { centavosToPesos } from './pricing.js';

function mapRefund(row, events = []) {
  if (!row) return null;
  return {
    id: row.id,
    paymentMethod: row.paymentMethod,
    originalPaidAmount: centavosToPesos(Number(row.amountCentavos)),
    approvedAmount: row.approvedAmountCentavos == null
      ? null
      : centavosToPesos(Number(row.approvedAmountCentavos)),
    currency: row.currency,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    reviewedAt: row.reviewedAt,
    events: events.map((event) => ({
      id: event.id,
      fromStatus: event.fromStatus,
      toStatus: event.toStatus,
      createdAt: event.createdAt,
    })),
  };
}

/** Returns only refund details that are safe for the authenticated customer response. */
export async function loadOrderRefund(client, orderId) {
  const result = await client.query(
    `SELECT id AS "internalId", public_id AS id, payment_method AS "paymentMethod",
            amount_centavos AS "amountCentavos",
            approved_amount_centavos AS "approvedAmountCentavos",
            currency, status, created_at AS "createdAt", updated_at AS "updatedAt",
            reviewed_at AS "reviewedAt"
     FROM order_refunds WHERE order_id = $1`,
    [orderId],
  );
  if (!result.rowCount) return null;
  const refund = result.rows[0];
  const events = await client.query(
    `SELECT public_id AS id, from_status AS "fromStatus", to_status AS "toStatus",
            created_at AS "createdAt"
     FROM refund_events WHERE refund_id = $1 ORDER BY created_at, id`,
    [refund.internalId],
  );
  return mapRefund(refund, events.rows);
}

/** Opens one review for a genuinely paid, cancelled GCash/Maya order. */
export async function ensureRefundReview(client, orderId) {
  const eligible = await client.query(
    `SELECT orders.id AS "orderId", requests.id AS "cancellationRequestId",
            attempts.id AS "paymentAttemptId", attempts.payment_method AS "paymentMethod",
            attempts.provider_payment_id AS "providerPaymentId",
            attempts.amount_centavos AS "amountCentavos", attempts.currency
     FROM orders
     JOIN order_cancellation_requests requests ON requests.order_id = orders.id
       AND requests.status = 'approved'
     JOIN payment_attempts attempts ON attempts.order_id = orders.id
       AND attempts.status = 'paid' AND attempts.provider_payment_id IS NOT NULL
     WHERE orders.id = $1 AND orders.order_status = 'cancelled'
       AND COALESCE(orders.payment_state, orders.payment_status) = 'paid'
       AND orders.payment_is_demo = false
       AND COALESCE(orders.payment_method_v2, orders.payment_method) IN ('gcash', 'maya')
       AND attempts.amount_centavos = round(orders.order_total * 100)::bigint
     ORDER BY requests.resolved_at DESC, attempts.updated_at DESC
     LIMIT 1
     FOR UPDATE OF orders, requests, attempts`,
    [orderId],
  );
  if (!eligible.rowCount) return null;
  const row = eligible.rows[0];
  await client.query(
    `UPDATE order_cancellation_requests
     SET refund_review_status = 'review_required'
     WHERE id = $1 AND refund_review_status <> 'review_required'`,
    [row.cancellationRequestId],
  );
  const inserted = await client.query(
    `INSERT INTO order_refunds
       (public_id, order_id, cancellation_request_id, payment_attempt_id, provider,
        payment_method, provider_payment_id, amount_centavos, currency)
     VALUES ($1, $2, $3, $4, 'paymongo', $5, $6, $7, $8)
     ON CONFLICT (payment_attempt_id) DO NOTHING
     RETURNING id`,
    [
      crypto.randomUUID(), row.orderId, row.cancellationRequestId, row.paymentAttemptId,
      row.paymentMethod, row.providerPaymentId, row.amountCentavos, row.currency,
    ],
  );
  if (inserted.rowCount) {
    await client.query(
      `INSERT INTO refund_events
         (public_id, refund_id, from_status, to_status, actor_type, idempotency_key, reason)
       VALUES ($1, $2, NULL, 'review_required', 'system', $3, $4)`,
      [
        crypto.randomUUID(), inserted.rows[0].id, crypto.randomUUID(),
        'Refund review opened for a verified paid cancellation.',
      ],
    );
  }
  return loadOrderRefund(client, row.orderId);
}
