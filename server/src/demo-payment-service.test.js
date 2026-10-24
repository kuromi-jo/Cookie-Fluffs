/**
 * @file demo-payment-service.test.js
 * @description Financial separation and idempotency tests for card-demo outcomes.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { processDemoCard } from './demo-payment-service.js';

const order = {
  id: 7,
  paymentIsDemo: true,
  paymentMethod: 'card',
  paymentStatus: 'awaiting_payment',
  total: '249.00',
  currency: 'PHP',
};

function clientWith(responses) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rowCount: 0, rows: [] };
      const next = responses.shift();
      assert.ok(next, `Unexpected query: ${sql}`);
      return next;
    },
  };
}

test('records an approved demo without changing genuine order payment state', async () => {
  const client = clientWith([
    { rowCount: 1, rows: [order] },
    { rowCount: 0, rows: [] },
    { rowCount: 0, rows: [] },
    { rowCount: 1, rows: [{ publicId: 'demo-1', scenario: 'visa_approved', status: 'demo_approved' }] },
  ]);
  const result = await processDemoCard(
    client, 4, 'order-1', 'key-1', 'visa_approved', { enabled: true, production: false },
  );
  assert.equal(result.status, 'demo_approved');
  assert.equal(client.calls.filter(({ sql }) => /^\s*UPDATE orders/i.test(sql)).length, 0);
  assert.equal(client.calls.at(-1).sql, 'COMMIT');
});

test('records the allowlisted Mastercard scenario as a demo decline', async () => {
  const client = clientWith([
    { rowCount: 1, rows: [order] },
    { rowCount: 0, rows: [] },
    { rowCount: 0, rows: [] },
    { rowCount: 1, rows: [{ publicId: 'demo-2', scenario: 'mastercard_declined', status: 'demo_declined' }] },
  ]);
  const result = await processDemoCard(
    client, 4, 'order-1', 'key-2', 'mastercard_declined', { enabled: true, production: false },
  );
  assert.equal(result.status, 'demo_declined');
  const insert = client.calls.find(({ sql }) => /INSERT INTO demo_payment_attempts/.test(sql));
  assert.equal(insert.params.at(-1), 'demo_declined');
});

test('reuses a matching request and rejects a changed scenario for the same key', async () => {
  const existing = { publicId: 'demo-1', scenario: 'visa_approved', status: 'demo_approved' };
  const reused = clientWith([
    { rowCount: 1, rows: [order] },
    { rowCount: 1, rows: [existing] },
  ]);
  assert.deepEqual(
    await processDemoCard(reused, 4, 'order-1', 'key-1', 'visa_approved', { enabled: true }),
    { attemptId: 'demo-1', scenario: 'visa_approved', status: 'demo_approved', isDemo: true },
  );
  assert.equal(reused.calls.some(({ sql }) => /INSERT INTO demo_payment_attempts/.test(sql)), false);

  const conflict = clientWith([
    { rowCount: 1, rows: [order] },
    { rowCount: 1, rows: [existing] },
  ]);
  await assert.rejects(
    processDemoCard(conflict, 4, 'order-1', 'key-1', 'mastercard_declined', { enabled: true }),
    (error) => error.status === 409,
  );
  assert.equal(conflict.calls.at(-1).sql, 'ROLLBACK');
});

test('rejects production use and genuine settled orders', async () => {
  await assert.rejects(
    processDemoCard({}, 4, 'order-1', 'key-1', 'visa_approved', { enabled: false, production: true }),
    (error) => error.status === 404,
  );
  const client = clientWith([
    { rowCount: 1, rows: [{ ...order, paymentStatus: 'paid' }] },
  ]);
  await assert.rejects(
    processDemoCard(client, 4, 'order-1', 'key-1', 'visa_approved', { enabled: true }),
    (error) => error.status === 409,
  );
});

test('allows an explicit same-order approval after a recorded decline', async () => {
  const client = clientWith([
    { rowCount: 1, rows: [order] },
    { rowCount: 0, rows: [] },
    { rowCount: 0, rows: [] },
    { rowCount: 1, rows: [{ publicId: 'demo-3', scenario: 'visa_approved', status: 'demo_approved' }] },
  ]);
  const result = await processDemoCard(
    client, 4, 'order-1', 'key-after-decline', 'visa_approved', { enabled: true, production: false },
  );
  assert.equal(result.status, 'demo_approved');
  assert.equal(client.calls.some(({ sql }) => /INSERT INTO demo_payment_attempts/.test(sql)), true);
  assert.equal(client.calls.at(-1).sql, 'COMMIT');
});
