/**
 * @file favorites.test.js
 * @description Favorites ownership, availability, duplication, and validation tests.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createFavoritesRouter } from './favorites.js';

function handler(router, path, method) {
  const layer = router.stack.find((candidate) => candidate.route?.path === path && candidate.route.methods[method]);
  return layer.route.stack.at(-1).handle;
}

function response() {
  return {
    statusCode: 200, body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    end() { return this; },
  };
}

test('lists favorites only for the authenticated owner', async () => {
  const calls = [];
  const router = createFavoritesRouter(async (text, params) => {
    calls.push({ text, params });
    return { rows: [{ id: 3, name: 'Saved Cookie' }], rowCount: 1 };
  });
  const res = response();
  await handler(router, '/', 'get')({ userId: 17 }, res, (error) => { throw error; });
  assert.deepEqual(calls[0].params, [17]);
  assert.equal(res.body.favorites[0].id, 3);
});

test('favorite save is idempotent and owner scoped', async () => {
  const calls = [];
  const router = createFavoritesRouter(async (text, params) => {
    calls.push({ text, params });
    if (text.startsWith('SELECT is_available')) return { rows: [{ is_available: true }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  });
  const res = response();
  await handler(router, '/:productId', 'put')({ userId: 8, params: { productId: '4' }, body: {} }, res, (error) => { throw error; });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(calls[1].params, [8, 4]);
  assert.deepEqual(res.body, { productId: 4, saved: true });
});

test('favorite save rejects unavailable products and extra fields', async () => {
  let calls = 0;
  const router = createFavoritesRouter(async () => {
    calls += 1;
    return { rows: [{ is_available: false }], rowCount: 1 };
  });
  const unavailable = response();
  await handler(router, '/:productId', 'put')({ userId: 8, params: { productId: '4' }, body: {} }, unavailable, (error) => { throw error; });
  assert.equal(unavailable.statusCode, 409);
  const unknown = response();
  await handler(router, '/:productId', 'put')({ userId: 8, params: { productId: '4' }, body: { userId: 2 } }, unknown, (error) => { throw error; });
  assert.equal(unknown.statusCode, 400);
  assert.equal(calls, 1);
});

test('favorite removal scopes the delete to owner and product', async () => {
  let params;
  const router = createFavoritesRouter(async (_text, values) => { params = values; return { rows: [], rowCount: 0 }; });
  const res = response();
  await handler(router, '/:productId', 'delete')({ userId: 6, params: { productId: '9' } }, res, (error) => { throw error; });
  assert.equal(res.statusCode, 204);
  assert.deepEqual(params, [6, 9]);
});
