/**
 * @file addresses.test.js
 * @description Saved-address route ownership, validation, and response tests.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createAddressesRouter } from './addresses.js';
import { getNcrGeography } from '../geography.js';

function handler(router, path, method) {
  const layer = router.stack.find((candidate) => candidate.route?.path === path && candidate.route.methods[method]);
  return layer.route.stack.at(-1).handle;
}

function response() {
  return { statusCode: 200, body: undefined, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; }, end() { return this; } };
}

const client = { release() {} };
const pool = { connect: async () => client };
const city = getNcrGeography().cities[0];
const body = {
  label: 'Home', recipientName: 'Maria Santos', recipientPhone: '0917 123 4567',
  addressLine1: '12 Cookie Street', addressLine2: '', cityCode: city.code,
  barangayCode: city.barangays[0].code, postalCode: '1100', makeDefault: true,
};

test('create route passes only validated canonical data with authenticated ownership', async () => {
  let received;
  const actions = {
    createAddress: async (_client, userId, value) => { received = { userId, value }; return { id: 'saved' }; },
  };
  const router = createAddressesRouter(pool, actions);
  const res = response();
  await handler(router, '/', 'post')({ userId: 7, body }, res, (error) => { throw error; });
  assert.equal(res.statusCode, 201);
  assert.equal(received.userId, 7);
  assert.equal(received.value.city, city.name);
});

test('update rejects unknown fields before opening a database connection', async () => {
  let connections = 0;
  const router = createAddressesRouter({ connect: async () => { connections += 1; return client; } }, {});
  const res = response();
  await handler(router, '/:id', 'put')({ params: { id: '123e4567-e89b-42d3-a456-426614174000' }, body: { ...body, makeDefault: true } }, res, (error) => { throw error; });
  assert.equal(res.statusCode, 400);
  assert.equal(connections, 0);
});

test('default route rejects extra fields', async () => {
  const router = createAddressesRouter(pool, {});
  const res = response();
  await handler(router, '/:id/default', 'put')({ params: { id: '123e4567-e89b-42d3-a456-426614174000' }, body: { userId: 2 } }, res, (error) => { throw error; });
  assert.equal(res.statusCode, 400);
});
