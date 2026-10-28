/**
 * @file order-lifecycle.js
 * @description Transactional fulfillment tracking, customer cancellation and operator authentication.
 */
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { ensureRefundReview } from './refund-service.js';
import { insertNotification } from './notification-service.js';

// Customer-facing copy per fulfillment status. Delivery and pickup differ at 'ready'
// and delivery adds 'out_for_delivery'; pickup never does.
const STATUS_NOTIFICATION = {
  confirmed: {
    event: 'order_confirmed',
    title: 'Order confirmed',
    body: () => 'Good news! Cookie Fluffs confirmed your order.',
  },
  preparing: {
    event: 'order_preparing',
    title: 'Baking started',
    body: () => 'Your cookies are being prepared with care.',
  },
  ready: {
    event: 'order_ready',
    title: (method) => (method === 'pickup' ? 'Ready for pickup' : 'Ready to go'),
    body: (method) => (method === 'pickup'
      ? 'Your order is ready. Come pick it up when you can.'
      : 'Your order is packed and ready for delivery.'),
  },
  out_for_delivery: {
    event: 'order_out_for_delivery',
    title: 'Out for delivery',
    body: () => 'Your cookies are on the way.',
  },
  completed: {
    event: 'order_completed',
    title: (method) => (method === 'pickup' ? 'Picked up' : 'Delivered'),
    body: (method) => (method === 'pickup'
      ? 'Enjoy your Cookie Fluffs! Tap to rate your cookies and help other customers choose.'
      : 'Your order was delivered. Tap to rate your cookies and help other customers choose.'),
  },
};

function statusCopyValue(value, method) {
  return typeof value === 'function' ? value(method) : value;
}

const scrypt = promisify(crypto.scrypt);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STATUS_VALUES = new Set(['placed', 'confirmed', 'preparing', 'ready', 'out_for_delivery', 'completed', 'cancelled']);
export const TRANSITIONS = {
  delivery: {
    placed: 'confirmed',
    confirmed: 'preparing',
    preparing: 'ready',
    ready: 'out_for_delivery',
    out_for_delivery: 'completed',
  },
  pickup: {
    placed: 'confirmed',
    confirmed: 'preparing',
    preparing: 'ready',
    ready: 'completed',
  },
};

const httpError = (status, message) => Object.assign(new Error(message), { status });

function requireUuid(value, message) {
  if (!UUID_RE.test(value ?? '')) throw httpError(400, message);
  return value.toLowerCase();
}

function cancellationRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    status: row.status,
    refundReviewStatus: row.refundReviewStatus,
    requestedAt: row.requestedAt,
    resolvedAt: row.resolvedAt,
  };
}

export async function hashOperatorCredential(credential) {
  if (typeof credential !== 'string' || credential.length < 32) {
    throw httpError(400, 'Operator credentials must contain at least 32 characters.');
  }
  const salt = crypto.randomBytes(16);
  const digest = await scrypt(credential, salt, 64);
  return `scrypt$${salt.toString('base64url')}$${Buffer.from(digest).toString('base64url')}`;
}

export async function verifyOperatorCredential(credential, stored) {
  if (typeof credential !== 'string' || typeof stored !== 'string') return false;
  const [algorithm, saltText, digestText, extra] = stored.split('$');
  if (algorithm !== 'scrypt' || !saltText || !digestText || extra) return false;
  try {
    const expected = Buffer.from(digestText, 'base64url');
    const actual = Buffer.from(await scrypt(credential, Buffer.from(saltText, 'base64url'), expected.length));
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

export async function createOrderOperator(client, displayName, credential, { canManageRefunds = false } = {}) {
  const name = typeof displayName === 'string' ? displayName.trim() : '';
  if (name.length < 2 || name.length > 80) throw httpError(400, 'Operator names must be 2 to 80 characters.');
  if (typeof canManageRefunds !== 'boolean') throw httpError(400, 'Refund permission must be true or false.');
  const credentialHash = await hashOperatorCredential(credential);
  const result = await client.query(
    `INSERT INTO order_operators (public_id, display_name, credential_hash, can_manage_refunds)
     VALUES ($1, $2, $3, $4)
     RETURNING public_id AS id, display_name AS "displayName",
               can_manage_refunds AS "canManageRefunds", created_at AS "createdAt"`,
    [crypto.randomUUID(), name, credentialHash, canManageRefunds],
  );
  return result.rows[0];
}

export async function rotateOrderOperatorCredential(client, publicId, currentCredential, newCredential) {
  const operatorId = requireUuid(publicId, 'Send a valid operator identifier.');
  await client.query('BEGIN');
  try {
    await authenticateOrderOperator(client, operatorId, currentCredential);
    const credentialHash = await hashOperatorCredential(newCredential);
    const result = await client.query(
      `UPDATE order_operators
       SET credential_hash = $2, credential_version = credential_version + 1,
           rotated_at = now(), last_used_at = NULL
       WHERE public_id = $1 AND revoked_at IS NULL
       RETURNING public_id AS id, display_name AS "displayName", credential_version AS "credentialVersion"`,
      [operatorId, credentialHash],
    );
    await client.query('COMMIT');
    return result.rows[0];
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  }
}

export async function revokeOrderOperator(client, publicId, credential) {
  const operatorId = requireUuid(publicId, 'Send a valid operator identifier.');
  await client.query('BEGIN');
  try {
    await authenticateOrderOperator(client, operatorId, credential);
    const result = await client.query(
      `UPDATE order_operators SET revoked_at = now()
       WHERE public_id = $1 AND revoked_at IS NULL
       RETURNING public_id AS id, display_name AS "displayName", revoked_at AS "revokedAt"`,
      [operatorId],
    );
    await client.query('COMMIT');
    return result.rows[0];
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  }
}

export async function authenticateOrderOperator(client, publicId, credential) {
  const operatorId = requireUuid(publicId, 'Operator authentication failed.');
  const result = await client.query(
    `SELECT id, public_id AS "publicId", display_name AS "displayName",
            credential_hash AS "credentialHash", can_manage_refunds AS "canManageRefunds"
     FROM order_operators WHERE public_id = $1 AND revoked_at IS NULL FOR UPDATE`,
    [operatorId],
  );
  const operator = result.rows[0];
  if (!operator || !(await verifyOperatorCredential(credential, operator.credentialHash))) {
    throw httpError(401, 'Operator authentication failed.');
  }
  return operator;
}

export async function loadOrderLifecycle(client, orderId, orderStatus) {
  const [eventResult, requestResult] = await Promise.all([
    client.query(
      `SELECT public_id AS id, from_status AS "fromStatus", to_status AS "toStatus",
              actor_type AS "actorType", created_at AS "createdAt"
       FROM order_status_events WHERE order_id = $1 ORDER BY created_at, id`,
      [orderId],
    ),
    client.query(
      `SELECT public_id AS id, status, refund_review_status AS "refundReviewStatus",
              requested_at AS "requestedAt", resolved_at AS "resolvedAt"
       FROM order_cancellation_requests WHERE order_id = $1
       ORDER BY requested_at DESC, id DESC LIMIT 1`,
      [orderId],
    ),
  ]);
  const cancellation = cancellationRow(requestResult.rows[0]);
  let cancellationAction = null;
  // A declined request is final: the shop has decided to keep the order, so no new request is offered.
  if (!cancellation) {
    if (['placed', 'confirmed'].includes(orderStatus)) cancellationAction = 'cancel';
    if (orderStatus === 'preparing') cancellationAction = 'request';
  }
  return {
    events: eventResult.rows,
    historyAvailable: eventResult.rowCount > 0,
    cancellation,
    cancellationAction,
  };
}

async function lockedOwnedOrder(client, userId, publicId) {
  const result = await client.query(
    `SELECT id, public_id AS "publicId", user_id AS "userId",
            order_status AS "orderStatus", fulfillment_method AS "fulfillmentMethod",
            COALESCE(payment_state, payment_status) AS "paymentStatus"
     FROM orders WHERE public_id = $1 AND user_id = $2 FOR UPDATE`,
    [publicId, userId],
  );
  if (!result.rowCount) throw httpError(404, 'Order not found.');
  return result.rows[0];
}

export async function requestOrderCancellation(client, userId, publicId, idempotencyKey) {
  const orderPublicId = requireUuid(publicId, 'Order not found.');
  const requestKey = requireUuid(idempotencyKey, 'Send a valid cancellation idempotency key.');
  await client.query('BEGIN');
  try {
    const order = await lockedOwnedOrder(client, userId, orderPublicId);
    const replay = await client.query(
      `SELECT public_id AS id, status, refund_review_status AS "refundReviewStatus",
              requested_at AS "requestedAt", resolved_at AS "resolvedAt"
       FROM order_cancellation_requests WHERE order_id = $1 AND idempotency_key = $2`,
      [order.id, requestKey],
    );
    if (replay.rowCount) {
      await client.query('COMMIT');
      return cancellationRow(replay.rows[0]);
    }
    const existing = await client.query(
      `SELECT public_id AS id, status, refund_review_status AS "refundReviewStatus",
              requested_at AS "requestedAt", resolved_at AS "resolvedAt"
       FROM order_cancellation_requests WHERE order_id = $1 AND status IN ('pending', 'approved')
       ORDER BY requested_at DESC, id DESC LIMIT 1`,
      [order.id],
    );
    if (existing.rowCount) {
      await client.query('COMMIT');
      return cancellationRow(existing.rows[0]);
    }
    const declined = await client.query(
      `SELECT 1 FROM order_cancellation_requests WHERE order_id = $1 AND status = 'declined' LIMIT 1`,
      [order.id],
    );
    if (declined.rowCount) {
      throw httpError(409, 'Cookie Fluffs already reviewed a cancellation for this order and is keeping it. Contact us if you need help.');
    }
    if (!['placed', 'confirmed', 'preparing'].includes(order.orderStatus)) {
      throw httpError(409, 'This order can no longer be cancelled. Contact Cookie Fluffs if you need help.');
    }
    const immediate = ['placed', 'confirmed'].includes(order.orderStatus);
    const refundReviewStatus = immediate && order.paymentStatus === 'paid' ? 'review_required' : 'not_required';
    const requestResult = await client.query(
      `INSERT INTO order_cancellation_requests
         (public_id, order_id, requested_by_user_id, idempotency_key, status,
          refund_review_status, resolved_at)
       VALUES ($1, $2, $3, $4, $5, $6, CASE WHEN $5 = 'approved' THEN now() ELSE NULL END)
       RETURNING public_id AS id, status, refund_review_status AS "refundReviewStatus",
                 requested_at AS "requestedAt", resolved_at AS "resolvedAt"`,
      [crypto.randomUUID(), order.id, userId, requestKey, immediate ? 'approved' : 'pending', refundReviewStatus],
    );
    if (immediate) {
      await client.query('UPDATE orders SET order_status = $2, updated_at = now() WHERE id = $1', [order.id, 'cancelled']);
      await client.query(
        `INSERT INTO order_status_events
           (public_id, order_id, from_status, to_status, actor_type, actor_user_id, idempotency_key)
         VALUES ($1, $2, $3, 'cancelled', 'customer', $4, $5)`,
        [crypto.randomUUID(), order.id, order.orderStatus, userId, requestKey],
      );
      // Cancellation is essential: delivered regardless of notify_order_updates.
      await insertNotification(client, {
        userId: order.userId,
        eventType: 'order_cancelled',
        title: 'Order cancelled',
        body: 'Your order was cancelled. If this was a mistake, place a new order anytime.',
        linkPath: `/orders/${order.publicId}`,
        dedupeKey: `cancelled:${requestKey}`,
      });
      await ensureRefundReview(client, order.id);
    }
    await client.query('COMMIT');
    return cancellationRow(requestResult.rows[0]);
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  }
}

async function lockedOrder(client, publicId) {
  const result = await client.query(
    `SELECT id, public_id AS "publicId", user_id AS "userId",
            order_status AS "orderStatus", fulfillment_method AS "fulfillmentMethod",
            COALESCE(payment_state, payment_status) AS "paymentStatus"
     FROM orders WHERE public_id = $1 FOR UPDATE`,
    [publicId],
  );
  if (!result.rowCount) throw httpError(404, 'Order not found.');
  return result.rows[0];
}

export async function advanceOrderStatus(client, operatorIdentity, orderPublicId, nextStatus, idempotencyKey) {
  const publicId = requireUuid(orderPublicId, 'Order not found.');
  const eventKey = requireUuid(idempotencyKey, 'Send a valid operation idempotency key.');
  if (!STATUS_VALUES.has(nextStatus) || ['placed', 'cancelled'].includes(nextStatus)) {
    throw httpError(400, 'Choose a valid next fulfillment status.');
  }
  await client.query('BEGIN');
  try {
    const operator = await authenticateOrderOperator(client, operatorIdentity.id, operatorIdentity.credential);
    const order = await lockedOrder(client, publicId);
    const replay = await client.query(
      'SELECT to_status AS "toStatus" FROM order_status_events WHERE order_id = $1 AND idempotency_key = $2',
      [order.id, eventKey],
    );
    if (replay.rowCount) {
      if (replay.rows[0].toStatus !== nextStatus) throw httpError(409, 'That operation key was already used for another status.');
      await client.query('COMMIT');
      return { orderId: publicId, orderStatus: nextStatus, replayed: true };
    }
    const expected = TRANSITIONS[order.fulfillmentMethod]?.[order.orderStatus];
    if (expected !== nextStatus) throw httpError(409, `The order cannot move from ${order.orderStatus} to ${nextStatus}.`);
    const pending = await client.query(
      `SELECT 1 FROM order_cancellation_requests WHERE order_id = $1 AND status = 'pending'`,
      [order.id],
    );
    if (pending.rowCount) throw httpError(409, 'Resolve the pending cancellation request before advancing this order.');
    await client.query('UPDATE orders SET order_status = $2, updated_at = now() WHERE id = $1', [order.id, nextStatus]);
    // Cash is collected on handover, so a completed cash order is also a paid order.
    if (nextStatus === 'completed') {
      const cashPaid = await client.query(
        `UPDATE orders SET payment_status = 'paid', payment_state = 'paid', updated_at = now()
         WHERE id = $1 AND payment_method IN ('cash_on_delivery', 'cash_on_pickup')
           AND COALESCE(payment_state, payment_status) IN ('pending', 'pending_cash')
         RETURNING id`,
        [order.id],
      );
      if (cashPaid.rowCount) {
        await insertNotification(client, {
          userId: order.userId,
          eventType: 'payment_paid',
          title: 'Payment received',
          body: 'Thanks! Your cash payment is recorded and your order is complete.',
          linkPath: `/orders/${order.publicId}`,
          dedupeKey: `cash_paid:${order.publicId}`,
        });
      }
    }
    await client.query(
      `INSERT INTO order_status_events
         (public_id, order_id, from_status, to_status, actor_type, operator_id, idempotency_key)
       VALUES ($1, $2, $3, $4, 'operator', $5, $6)`,
      [crypto.randomUUID(), order.id, order.orderStatus, nextStatus, operator.id, eventKey],
    );
    const copy = STATUS_NOTIFICATION[nextStatus];
    if (copy) {
      await insertNotification(client, {
        userId: order.userId,
        eventType: copy.event,
        title: statusCopyValue(copy.title, order.fulfillmentMethod),
        body: statusCopyValue(copy.body, order.fulfillmentMethod),
        linkPath: `/orders/${order.publicId}`,
        dedupeKey: `status:${eventKey}`,
      });
    }
    await client.query('UPDATE order_operators SET last_used_at = now() WHERE id = $1', [operator.id]);
    await client.query('COMMIT');
    return { orderId: publicId, orderStatus: nextStatus, replayed: false };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  }
}

export async function resolveCancellationRequest(client, operatorIdentity, requestPublicId, decision, idempotencyKey) {
  const requestId = requireUuid(requestPublicId, 'Cancellation request not found.');
  const eventKey = requireUuid(idempotencyKey, 'Send a valid operation idempotency key.');
  if (!['approve', 'decline'].includes(decision)) throw httpError(400, 'Choose approve or decline.');
  await client.query('BEGIN');
  try {
    const operator = await authenticateOrderOperator(client, operatorIdentity.id, operatorIdentity.credential);
    const requestResult = await client.query(
      `SELECT requests.id, requests.order_id AS "orderId", requests.status,
              orders.public_id AS "orderPublicId", orders.user_id AS "orderUserId",
              orders.order_status AS "orderStatus",
              COALESCE(orders.payment_state, orders.payment_status) AS "paymentStatus"
       FROM order_cancellation_requests requests
       JOIN orders ON orders.id = requests.order_id
       WHERE requests.public_id = $1 FOR UPDATE OF requests, orders`,
      [requestId],
    );
    if (!requestResult.rowCount) throw httpError(404, 'Cancellation request not found.');
    const request = requestResult.rows[0];
    const target = decision === 'approve' ? 'approved' : 'declined';
    if (request.status !== 'pending') {
      if (request.status !== target) throw httpError(409, 'This cancellation request was already resolved differently.');
      await client.query('COMMIT');
      return { requestId, status: target, orderStatus: request.orderStatus, replayed: true };
    }
    if (request.orderStatus !== 'preparing') throw httpError(409, 'This order is no longer eligible for cancellation review.');
    const refundReviewStatus = decision === 'approve' && request.paymentStatus === 'paid'
      ? 'review_required'
      : 'not_required';
    await client.query(
      `UPDATE order_cancellation_requests
       SET status = $2, refund_review_status = $3, resolved_by_operator_id = $4, resolved_at = now()
       WHERE id = $1`,
      [request.id, target, refundReviewStatus, operator.id],
    );
    if (decision === 'approve') {
      await client.query('UPDATE orders SET order_status = $2, updated_at = now() WHERE id = $1', [request.orderId, 'cancelled']);
      await insertNotification(client, {
        userId: request.orderUserId,
        eventType: 'order_cancelled',
        title: 'Order cancelled',
        body: 'Your cancellation request was approved and the order is now cancelled.',
        linkPath: `/orders/${request.orderPublicId}`,
        dedupeKey: `cancelled:${eventKey}`,
      });
      await client.query(
        `INSERT INTO order_status_events
           (public_id, order_id, from_status, to_status, actor_type, operator_id, idempotency_key)
         VALUES ($1, $2, $3, 'cancelled', 'operator', $4, $5)`,
        [crypto.randomUUID(), request.orderId, request.orderStatus, operator.id, eventKey],
      );
      await ensureRefundReview(client, request.orderId);
    }
    await client.query('UPDATE order_operators SET last_used_at = now() WHERE id = $1', [operator.id]);
    await client.query('COMMIT');
    return { requestId, status: target, orderStatus: decision === 'approve' ? 'cancelled' : request.orderStatus, replayed: false };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  }
}

export async function reviewOrderRefund(
  client,
  operatorIdentity,
  refundPublicId,
  decision,
  idempotencyKey,
  reason,
) {
  const refundId = requireUuid(refundPublicId, 'Refund review not found.');
  const eventKey = requireUuid(idempotencyKey, 'Send a valid refund operation idempotency key.');
  const reviewReason = typeof reason === 'string' ? reason.trim() : '';
  if (!['approve', 'reject'].includes(decision)) throw httpError(400, 'Choose approve or reject.');
  if (reviewReason.length < 2 || reviewReason.length > 500) {
    throw httpError(400, 'Refund review reasons must be 2 to 500 characters.');
  }
  await client.query('BEGIN');
  try {
    const operator = await authenticateOrderOperator(client, operatorIdentity.id, operatorIdentity.credential);
    if (!operator.canManageRefunds) throw httpError(403, 'This operator cannot manage refunds.');
    const result = await client.query(
      `SELECT order_refunds.id, order_refunds.status,
              order_refunds.amount_centavos AS "amountCentavos",
              orders.public_id AS "orderPublicId", orders.user_id AS "orderUserId"
       FROM order_refunds
       JOIN orders ON orders.id = order_refunds.order_id
       WHERE order_refunds.public_id = $1 FOR UPDATE OF order_refunds`,
      [refundId],
    );
    if (!result.rowCount) throw httpError(404, 'Refund review not found.');
    const refund = result.rows[0];
    const target = decision === 'approve' ? 'approved' : 'rejected';
    const replay = await client.query(
      `SELECT to_status AS "toStatus" FROM refund_events
       WHERE refund_id = $1 AND idempotency_key = $2`,
      [refund.id, eventKey],
    );
    if (replay.rowCount) {
      if (replay.rows[0].toStatus !== target) {
        throw httpError(409, 'That operation key was already used for another refund decision.');
      }
      await client.query('COMMIT');
      return { refundId, status: target, replayed: true };
    }
    if (refund.status !== 'review_required') {
      if (refund.status !== target) throw httpError(409, 'This refund review was already resolved differently.');
      await client.query('COMMIT');
      return { refundId, status: target, replayed: true };
    }
    await client.query(
      `UPDATE order_refunds
       SET status = $2,
           approved_amount_centavos = CASE WHEN $2 = 'approved' THEN amount_centavos ELSE NULL END,
           review_reason = $3, reviewed_by_operator_id = $4,
           reviewed_at = now(), updated_at = now()
       WHERE id = $1`,
      [refund.id, target, reviewReason, operator.id],
    );
    await client.query(
      `INSERT INTO refund_events
         (public_id, refund_id, from_status, to_status, actor_type, operator_id, idempotency_key, reason)
       VALUES ($1, $2, 'review_required', $3, 'operator', $4, $5, $6)`,
      [crypto.randomUUID(), refund.id, target, operator.id, eventKey, reviewReason],
    );
    // Essential payment-category notification. Customer-safe copy only: never includes the
    // internal review reason, operator identity, or provider identifiers.
    await insertNotification(client, {
      userId: refund.orderUserId,
      eventType: target === 'approved' ? 'refund_approved' : 'refund_rejected',
      title: target === 'approved' ? 'Refund approved' : 'Refund update',
      body: target === 'approved'
        ? 'Your refund has been approved and is being processed.'
        : 'We reviewed your refund request. See your order for details.',
      linkPath: `/orders/${refund.orderPublicId}`,
      dedupeKey: `refund:${eventKey}`,
    });
    await client.query('UPDATE order_operators SET last_used_at = now() WHERE id = $1', [operator.id]);
    await client.query('COMMIT');
    return { refundId, status: target, replayed: false };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  }
}
