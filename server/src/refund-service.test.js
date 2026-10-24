/**
 * @file refund-service.test.js
 * @description Internal refund eligibility and customer-safe refund snapshot tests.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { ensureRefundReview, loadOrderRefund } from './refund-service.js';

test('keeps ineligible cancellations free of refund records', async () => {
  const client = { query: async () => ({ rowCount: 0, rows: [] }) };
  assert.equal(await ensureRefundReview(client, 9), null);
});

test('creates one full review from verified server-side payment data', async () => {
  const calls = [];
  const client = {
    async query(text, params = []) {
      const sql = String(text).replace(/\s+/g, ' ').trim();
      calls.push({ sql, params });
      if (sql.includes('FROM orders') && sql.includes('JOIN payment_attempts')) {
        return { rowCount: 1, rows: [{
          orderId: 9,
          cancellationRequestId: 10,
          paymentAttemptId: 11,
          paymentMethod: 'gcash',
          providerPaymentId: 'pay_verified',
          amountCentavos: 28_300,
          currency: 'PHP',
        }] };
      }
      if (sql.startsWith('UPDATE order_cancellation_requests')) return { rowCount: 1, rows: [] };
      if (sql.startsWith('INSERT INTO order_refunds')) return { rowCount: 1, rows: [{ id: 12 }] };
      if (sql.startsWith('INSERT INTO refund_events')) return { rowCount: 1, rows: [] };
      if (sql.includes('FROM order_refunds WHERE order_id')) return { rowCount: 1, rows: [{
        internalId: 12,
        id: '123e4567-e89b-42d3-a456-426614174000',
        paymentMethod: 'gcash',
        amountCentavos: 28_300,
        approvedAmountCentavos: null,
        currency: 'PHP',
        status: 'review_required',
        createdAt: new Date(),
        updatedAt: new Date(),
        reviewedAt: null,
      }] };
      if (sql.includes('FROM refund_events WHERE refund_id')) return { rowCount: 1, rows: [{
        id: '223e4567-e89b-42d3-a456-426614174000',
        fromStatus: null,
        toStatus: 'review_required',
        createdAt: new Date(),
      }] };
      throw new Error(`Unexpected query: ${sql}`);
    },
  };
  const refund = await ensureRefundReview(client, 9);
  assert.equal(refund.originalPaidAmount, 283);
  assert.equal(refund.status, 'review_required');
  const eligibility = calls.find((call) => call.sql.includes('JOIN payment_attempts'));
  assert.match(eligibility.sql, /requests\.status = 'approved'/);
  assert.match(eligibility.sql, /orders\.order_status = 'cancelled'/);
  assert.match(eligibility.sql, /payment_state, orders\.payment_status\) = 'paid'/);
  assert.match(eligibility.sql, /orders\.payment_is_demo = false/);
  assert.match(eligibility.sql, /IN \('gcash', 'maya'\)/);
  assert.match(eligibility.sql, /attempts\.provider_payment_id IS NOT NULL/);
  assert.match(eligibility.sql, /attempts\.amount_centavos = round\(orders\.order_total \* 100\)/);
  const insert = calls.find((call) => call.sql.startsWith('INSERT INTO order_refunds'));
  assert.deepEqual(insert.params.slice(1), [9, 10, 11, 'gcash', 'pay_verified', 28_300, 'PHP']);
});

test('customer snapshots omit provider identifiers and internal review reasons', async () => {
  const client = {
    async query(text) {
      const sql = String(text);
      if (sql.includes('FROM order_refunds')) return { rowCount: 1, rows: [{
        internalId: 4,
        id: '123e4567-e89b-42d3-a456-426614174000',
        paymentMethod: 'maya',
        amountCentavos: 10_000,
        approvedAmountCentavos: 10_000,
        currency: 'PHP',
        status: 'approved',
        createdAt: new Date(),
        updatedAt: new Date(),
        reviewedAt: new Date(),
      }] };
      return { rowCount: 1, rows: [{
        id: '223e4567-e89b-42d3-a456-426614174000', fromStatus: 'review_required',
        toStatus: 'approved', createdAt: new Date(), reason: 'internal only',
      }] };
    },
  };
  const refund = await loadOrderRefund(client, 9);
  assert.equal(refund.approvedAmount, 100);
  assert.equal('providerPaymentId' in refund, false);
  assert.equal('reason' in refund.events[0], false);
});
