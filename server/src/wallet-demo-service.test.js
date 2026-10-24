/**
 * @file wallet-demo-service.test.js
 * @description Ownership, idempotency, cancellation, and rollback tests for wallet demonstrations.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { processDemoWallet } from './wallet-demo-service.js';

const order = {
  id: 9,
  paymentIsDemo: true,
  paymentMethod: 'gcash',
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
      if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)) return { rowCount: 0, rows: [] };
      const next = responses.shift();
      if (next instanceof Error) throw next;
      assert.ok(next, `Unexpected query: ${sql}`);
      return next;
    },
  };
}

test('records server-derived wallet approval without changing financial state', async () => {
  const client = clientWith([
    { rowCount: 1, rows: [order] },
    { rowCount: 0, rows: [] },
    { rowCount: 0, rows: [] },
    { rowCount: 1, rows: [{ publicId: 'wallet-1', walletMethod: 'gcash', status: 'demo_approved' }] },
  ]);
  const result = await processDemoWallet(client, 4, 'order-1', 'key-1', 'confirm', { enabled: true });
  assert.equal(result.status, 'demo_approved');
  const insert = client.calls.find(({ sql }) => /INSERT INTO wallet_demo_attempts/.test(sql));
  assert.deepEqual(insert.params.slice(1), [9, 'gcash', 'key-1', 24900, 'PHP', 'demo_approved']);
  assert.equal(client.calls.some(({ sql }) => /^\s*UPDATE orders/i.test(sql)), false);
});

test('records cancellation and permits an explicit later approval', async () => {
  const cancelled = clientWith([
    { rowCount: 1, rows: [{ ...order, paymentMethod: 'maya' }] },
    { rowCount: 0, rows: [] },
    { rowCount: 0, rows: [] },
    { rowCount: 1, rows: [{ publicId: 'wallet-2', walletMethod: 'maya', status: 'demo_cancelled' }] },
  ]);
  assert.equal((await processDemoWallet(cancelled, 4, 'order-1', 'key-cancel', 'cancel', { enabled: true })).status, 'demo_cancelled');

  const retry = clientWith([
    { rowCount: 1, rows: [{ ...order, paymentMethod: 'maya' }] },
    { rowCount: 0, rows: [] },
    { rowCount: 0, rows: [] },
    { rowCount: 1, rows: [{ publicId: 'wallet-3', walletMethod: 'maya', status: 'demo_approved' }] },
  ]);
  assert.equal((await processDemoWallet(retry, 4, 'order-1', 'key-confirm', 'confirm', { enabled: true })).status, 'demo_approved');
});

test('replays one matching key and rejects a changed action', async () => {
  const existing = { publicId: 'wallet-1', walletMethod: 'gcash', status: 'demo_approved' };
  const replay = clientWith([{ rowCount: 1, rows: [order] }, { rowCount: 1, rows: [existing] }]);
  assert.deepEqual(await processDemoWallet(replay, 4, 'order-1', 'key-1', 'confirm', { enabled: true }), {
    attemptId: 'wallet-1', walletMethod: 'gcash', status: 'demo_approved', isDemo: true,
  });
  const conflict = clientWith([{ rowCount: 1, rows: [order] }, { rowCount: 1, rows: [existing] }]);
  await assert.rejects(
    processDemoWallet(conflict, 4, 'order-1', 'key-1', 'cancel', { enabled: true }),
    (error) => error.status === 409,
  );
});

test('rejects production, wrong ownership, and genuine payment orders', async () => {
  await assert.rejects(
    processDemoWallet({}, 4, 'order-1', 'key-1', 'confirm', { enabled: false, production: true }),
    (error) => error.status === 404,
  );
  const missing = clientWith([{ rowCount: 0, rows: [] }]);
  await assert.rejects(processDemoWallet(missing, 4, 'order-1', 'key-1', 'confirm', { enabled: true }),
    (error) => error.status === 404);
  const paid = clientWith([{ rowCount: 1, rows: [{ ...order, paymentStatus: 'paid' }] }]);
  await assert.rejects(processDemoWallet(paid, 4, 'order-1', 'key-1', 'confirm', { enabled: true }),
    (error) => error.status === 409);
});

test('rolls back if wallet-attempt persistence fails', async () => {
  const client = clientWith([
    { rowCount: 1, rows: [order] },
    { rowCount: 0, rows: [] },
    { rowCount: 0, rows: [] },
    new Error('synthetic insert failure'),
  ]);
  await assert.rejects(processDemoWallet(client, 4, 'order-1', 'key-1', 'confirm', { enabled: true }));
  assert.equal(client.calls.at(-1).sql, 'ROLLBACK');
});
