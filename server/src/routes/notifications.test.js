/**
 * @file notifications.test.js
 * @description Owner-scoped notification route tests: list pagination, unread count,
 * mark-one, mark-all, and input/ownership guards.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createNotificationsRouter } from './notifications.js';

function handler(router, path, method) {
  const layer = router.stack.find((candidate) => candidate.route?.path === path && candidate.route.methods[method]);
  assert.ok(layer, `Expected ${method.toUpperCase()} ${path}`);
  return layer.route.stack.at(-1).handle;
}

function response() {
  return {
    statusCode: 200,
    body: undefined,
    ended: false,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    end() { this.ended = true; return this; },
  };
}

test('lists notifications scoped to the authenticated owner', async () => {
  let params;
  const row = {
    id: 'pub-1', category: 'order', eventType: 'order_placed', title: 'Order placed',
    body: 'Thanks!', linkPath: '/orders/x', readAt: null, createdAt: new Date(), internalId: 5,
  };
  const router = createNotificationsRouter(async (_text, values) => { params = values; return { rows: [row], rowCount: 1 }; });
  const res = response();
  await handler(router, '/', 'get')({ userId: 7, query: {} }, res, (error) => { throw error; });
  assert.equal(params[0], 7); // owner-scoped
  assert.equal(res.body.notifications.length, 1);
  assert.equal(res.body.notifications[0].read, false);
  // Internal id is not leaked to the client.
  assert.equal('internalId' in res.body.notifications[0], false);
});

test('returns the owner unread count', async () => {
  let params;
  const router = createNotificationsRouter(async (_text, values) => { params = values; return { rows: [{ count: 5 }] }; });
  const res = response();
  await handler(router, '/unread-count', 'get')({ userId: 7 }, res, (error) => { throw error; });
  assert.deepEqual(params, [7]);
  assert.deepEqual(res.body, { count: 5 });
});

test('marks a single owned notification read (204) and 404s an unknown one', async () => {
  const okRouter = createNotificationsRouter(async (_text, values) => {
    assert.equal(values[0], 7); // scoped to owner
    return { rowCount: 1 };
  });
  const okRes = response();
  await handler(okRouter, '/:id/read', 'post')(
    { userId: 7, params: { id: '11111111-1111-4111-8111-111111111111' }, body: {} },
    okRes, (error) => { throw error; },
  );
  assert.equal(okRes.statusCode, 204);
  assert.equal(okRes.ended, true);

  const missRouter = createNotificationsRouter(async () => ({ rowCount: 0 }));
  const missRes = response();
  await handler(missRouter, '/:id/read', 'post')(
    { userId: 7, params: { id: '22222222-2222-4222-8222-222222222222' }, body: {} },
    missRes, (error) => { throw error; },
  );
  assert.equal(missRes.statusCode, 404);
});

test('rejects a non-uuid notification id without querying', async () => {
  let calls = 0;
  const router = createNotificationsRouter(async () => { calls += 1; return { rowCount: 0 }; });
  const res = response();
  await handler(router, '/:id/read', 'post')(
    { userId: 7, params: { id: 'not-a-uuid' }, body: {} }, res, (error) => { throw error; },
  );
  assert.equal(res.statusCode, 404);
  assert.equal(calls, 0);
});

test('marks all owner notifications read and returns the count', async () => {
  let params;
  const router = createNotificationsRouter(async (_text, values) => { params = values; return { rowCount: 3 }; });
  const res = response();
  await handler(router, '/read-all', 'post')({ userId: 7, body: {} }, res, (error) => { throw error; });
  assert.deepEqual(params, [7]);
  assert.deepEqual(res.body, { updated: 3 });
});
