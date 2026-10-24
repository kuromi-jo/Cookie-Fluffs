/**
 * @file order-lifecycle.test.js
 * @description Credential, transition and customer-cancellation rules for order tracking.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  advanceOrderStatus,
  hashOperatorCredential,
  requestOrderCancellation,
  reviewOrderRefund,
  verifyOperatorCredential,
} from './order-lifecycle.js';

const orderId = '123e4567-e89b-42d3-a456-426614174000';
const operatorId = '223e4567-e89b-42d3-a456-426614174000';
const key = '323e4567-e89b-42d3-a456-426614174000';
const credential = 'operator-test-credential-with-more-than-32-characters';

test('hashes operator credentials with a random salt and verifies without storing the token', async () => {
  const first = await hashOperatorCredential(credential);
  const second = await hashOperatorCredential(credential);
  assert.notEqual(first, second);
  assert.equal(first.includes(credential), false);
  assert.equal(await verifyOperatorCredential(credential, first), true);
  assert.equal(await verifyOperatorCredential(`${credential}-wrong`, first), false);
});

test('immediately cancels a paid placed order while preserving payment for refund review', async () => {
  const calls = [];
  const client = {
    async query(text, params = []) {
      const sql = String(text).replace(/\s+/g, ' ').trim();
      calls.push({ sql, params });
      if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)) return { rowCount: 0, rows: [] };
      if (sql.includes('FROM orders WHERE public_id') && sql.includes('user_id')) {
        return { rowCount: 1, rows: [{ id: 9, orderStatus: 'placed', fulfillmentMethod: 'delivery', paymentStatus: 'paid' }] };
      }
      if (sql.includes('idempotency_key = $2')) return { rowCount: 0, rows: [] };
      if (sql.includes("status IN ('pending', 'approved')")) return { rowCount: 0, rows: [] };
      if (sql.startsWith('INSERT INTO order_cancellation_requests')) {
        return { rowCount: 1, rows: [{ id: crypto.randomUUID(), status: 'approved', refundReviewStatus: 'review_required', requestedAt: new Date(), resolvedAt: new Date() }] };
      }
      if (sql.startsWith('UPDATE orders') || sql.startsWith('INSERT INTO order_status_events')) return { rowCount: 1, rows: [] };
      if (sql.includes('FROM orders') && sql.includes('JOIN payment_attempts')) return { rowCount: 0, rows: [] };
      throw new Error(`Unexpected query: ${sql}`);
    },
  };
  const result = await requestOrderCancellation(client, 7, orderId, key);
  assert.equal(result.status, 'approved');
  assert.equal(result.refundReviewStatus, 'review_required');
  assert.ok(calls.some((call) => call.sql.startsWith('UPDATE orders') && call.params[1] === 'cancelled'));
  assert.equal(calls.at(-1).sql, 'COMMIT');
});

test('requires explicit refund permission and records an idempotent review decision', async () => {
  const hash = await hashOperatorCredential(credential);
  const calls = [];
  const client = {
    async query(text, params = []) {
      const sql = String(text).replace(/\s+/g, ' ').trim();
      calls.push({ sql, params });
      if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)) return { rowCount: 0, rows: [] };
      if (sql.includes('FROM order_operators WHERE public_id')) return { rowCount: 1, rows: [{
        id: 4, publicId: operatorId, displayName: 'Refund Baker', credentialHash: hash, canManageRefunds: true,
      }] };
      if (sql.includes('FROM order_refunds WHERE public_id')) {
        return { rowCount: 1, rows: [{ id: 8, status: 'review_required', amountCentavos: 28_300 }] };
      }
      if (sql.includes('FROM refund_events')) return { rowCount: 0, rows: [] };
      if (sql.startsWith('UPDATE order_refunds') || sql.startsWith('INSERT INTO refund_events')
        || sql.startsWith('UPDATE order_operators')) return { rowCount: 1, rows: [] };
      throw new Error(`Unexpected query: ${sql}`);
    },
  };
  const result = await reviewOrderRefund(
    client,
    { id: operatorId, credential },
    orderId,
    'approve',
    key,
    'Approved after checking the paid cancellation.',
  );
  assert.equal(result.status, 'approved');
  assert.ok(calls.some((call) => call.sql.startsWith('UPDATE order_refunds')));
  assert.equal(calls.at(-1).sql, 'COMMIT');
});

test('blocks an authenticated fulfillment operator from refund review', async () => {
  const hash = await hashOperatorCredential(credential);
  const client = {
    async query(text) {
      const sql = String(text).replace(/\s+/g, ' ').trim();
      if (['BEGIN', 'ROLLBACK'].includes(sql)) return { rowCount: 0, rows: [] };
      if (sql.includes('FROM order_operators WHERE public_id')) return { rowCount: 1, rows: [{
        id: 4, publicId: operatorId, displayName: 'Baker', credentialHash: hash, canManageRefunds: false,
      }] };
      throw new Error('Refund records must not be reached.');
    },
  };
  await assert.rejects(
    () => reviewOrderRefund(client, { id: operatorId, credential }, orderId, 'reject', key, 'Not eligible.'),
    (error) => error.status === 403,
  );
});

test('rolls back a refund decision when its audit event cannot be recorded', async () => {
  const hash = await hashOperatorCredential(credential);
  const calls = [];
  const client = {
    async query(text) {
      const sql = String(text).replace(/\s+/g, ' ').trim();
      calls.push(sql);
      if (['BEGIN', 'ROLLBACK'].includes(sql)) return { rowCount: 0, rows: [] };
      if (sql.includes('FROM order_operators WHERE public_id')) return { rowCount: 1, rows: [{
        id: 4, publicId: operatorId, displayName: 'Refund Baker', credentialHash: hash, canManageRefunds: true,
      }] };
      if (sql.includes('FROM order_refunds WHERE public_id')) {
        return { rowCount: 1, rows: [{ id: 8, status: 'review_required', amountCentavos: 28_300 }] };
      }
      if (sql.includes('FROM refund_events')) return { rowCount: 0, rows: [] };
      if (sql.startsWith('UPDATE order_refunds')) return { rowCount: 1, rows: [] };
      if (sql.startsWith('INSERT INTO refund_events')) throw new Error('audit insert failed');
      throw new Error(`Unexpected query: ${sql}`);
    },
  };
  await assert.rejects(() => reviewOrderRefund(
    client, { id: operatorId, credential }, orderId, 'approve', key, 'Approved review.',
  ));
  assert.equal(calls.at(-1), 'ROLLBACK');
  assert.equal(calls.includes('COMMIT'), false);
});

test('records a preparing cancellation request without changing fulfillment', async () => {
  const calls = [];
  const client = {
    async query(text) {
      const sql = String(text).replace(/\s+/g, ' ').trim();
      calls.push(sql);
      if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)) return { rowCount: 0, rows: [] };
      if (sql.includes('FROM orders WHERE public_id')) {
        return { rowCount: 1, rows: [{ id: 9, orderStatus: 'preparing', fulfillmentMethod: 'pickup', paymentStatus: 'pending_cash' }] };
      }
      if (sql.includes('idempotency_key = $2') || sql.includes("status IN ('pending', 'approved')")) return { rowCount: 0, rows: [] };
      if (sql.startsWith('INSERT INTO order_cancellation_requests')) {
        return { rowCount: 1, rows: [{ id: crypto.randomUUID(), status: 'pending', refundReviewStatus: 'not_required', requestedAt: new Date(), resolvedAt: null }] };
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
  };
  assert.equal((await requestOrderCancellation(client, 7, orderId, key)).status, 'pending');
  assert.equal(calls.some((sql) => sql.startsWith('UPDATE orders')), false);
});

test('enforces pickup transitions with an authenticated individual operator', async () => {
  const hash = await hashOperatorCredential(credential);
  const calls = [];
  const client = {
    async query(text, params = []) {
      const sql = String(text).replace(/\s+/g, ' ').trim();
      calls.push({ sql, params });
      if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)) return { rowCount: 0, rows: [] };
      if (sql.includes('FROM order_operators WHERE public_id')) {
        return { rowCount: 1, rows: [{ id: 4, publicId: operatorId, displayName: 'Baker One', credentialHash: hash }] };
      }
      if (sql.includes('FROM orders WHERE public_id') && sql.includes('FOR UPDATE')) {
        return { rowCount: 1, rows: [{ id: 9, orderStatus: 'ready', fulfillmentMethod: 'pickup', paymentStatus: 'pending_cash' }] };
      }
      if (sql.includes('FROM order_status_events') || sql.includes('FROM order_cancellation_requests')) return { rowCount: 0, rows: [] };
      if (sql.startsWith('UPDATE orders') || sql.startsWith('INSERT INTO order_status_events') || sql.startsWith('UPDATE order_operators')) {
        return { rowCount: 1, rows: [] };
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
  };
  const result = await advanceOrderStatus(
    client,
    { id: operatorId, credential },
    orderId,
    'completed',
    key,
  );
  assert.equal(result.orderStatus, 'completed');
  assert.ok(calls.some((call) => call.sql.startsWith('INSERT INTO order_status_events')));
});

test('rejects invalid or revoked operator credentials before order mutation', async () => {
  const client = {
    async query(text) {
      if (['BEGIN', 'ROLLBACK'].includes(String(text))) return { rowCount: 0, rows: [] };
      if (String(text).includes('FROM order_operators')) return { rowCount: 0, rows: [] };
      throw new Error('Order data must not be reached.');
    },
  };
  await assert.rejects(
    () => advanceOrderStatus(client, { id: operatorId, credential }, orderId, 'confirmed', key),
    (error) => error.status === 401,
  );
});
