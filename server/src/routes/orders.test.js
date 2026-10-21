/**
 * @file orders.test.js
 * @description Authentication and request-boundary tests for order routes.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.JWT_SECRET = 'test-only-cookie-fluffs-orders-secret';

const { signToken } = await import('../auth.js');
const { createOrdersRouter } = await import('./orders.js');

function responseRecorder() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

function layers() {
  const router = createOrdersRouter({ connect: async () => { throw new Error('Database should not be reached.'); } });
  const auth = router.stack.find((layer) => !layer.route).handle;
  const post = router.stack.find((layer) => layer.route?.path === '/' && layer.route.methods.post).route.stack[0].handle;
  const get = router.stack.find((layer) => layer.route?.path === '/:id' && layer.route.methods.get).route.stack[0].handle;
  return { auth, post, get };
}

const validCheckout = {
  idempotencyKey: '223e4567-e89b-42d3-a456-426614174000',
  fulfillmentMethod: 'pickup',
  paymentMethod: 'cash_on_pickup',
  schedulingMode: 'asap',
  contactName: 'Sample Customer',
  contactPhone: '09171234567',
  notes: '',
};

test('rejects missing and invalid JWTs before order placement', () => {
  const { auth } = layers();
  for (const authorization of [undefined, 'Bearer invalid-token']) {
    const req = { headers: authorization ? { authorization } : {} };
    const res = responseRecorder();
    let continued = false;
    auth(req, res, () => { continued = true; });
    assert.equal(continued, false);
    assert.equal(res.statusCode, 401);
  }
});

test('uses the authenticated JWT subject and rejects client user ID injection', async () => {
  const { auth, post } = layers();
  const req = {
    headers: { authorization: `Bearer ${signToken(42)}` },
    body: { userId: 99 },
  };
  const res = responseRecorder();
  auth(req, res, () => undefined);
  assert.equal(req.userId, 42);
  await post(req, res, (error) => { throw error; });
  assert.equal(res.statusCode, 400);
  assert.match(res.body.message, /Unknown checkout field/);
});

test('accepts a valid authenticated checkout and passes the JWT subject to the service', async () => {
  const client = { releaseCalled: false, release() { this.releaseCalled = true; } };
  const dbPool = { connect: async () => client };
  let receivedUserId;
  const orderActions = {
    async createOrder(_client, userId) {
      receivedUserId = userId;
      return { created: true, order: { id: '123e4567-e89b-42d3-a456-426614174000' } };
    },
    getOrderByPublicId: async () => null,
  };
  const router = createOrdersRouter(dbPool, orderActions);
  const auth = router.stack.find((layer) => !layer.route).handle;
  const post = router.stack.find((layer) => layer.route?.path === '/' && layer.route.methods.post).route.stack[0].handle;
  const req = { headers: { authorization: `Bearer ${signToken(42)}` }, body: validCheckout };
  const res = responseRecorder();
  auth(req, res, () => undefined);
  await post(req, res, (error) => { throw error; });
  assert.equal(receivedUserId, 42);
  assert.equal(res.statusCode, 201);
  assert.equal(client.releaseCalled, true);
});

test('returns not found when an authenticated customer does not own the order', async () => {
  const client = { releaseCalled: false, release() { this.releaseCalled = true; } };
  const dbPool = { connect: async () => client };
  const orderActions = {
    createOrder: async () => null,
    getOrderByPublicId: async (_client, userId) => {
      assert.equal(userId, 42);
      return null;
    },
  };
  const router = createOrdersRouter(dbPool, orderActions);
  const auth = router.stack.find((layer) => !layer.route).handle;
  const get = router.stack.find((layer) => layer.route?.path === '/:id' && layer.route.methods.get).route.stack[0].handle;
  const req = {
    headers: { authorization: `Bearer ${signToken(42)}` },
    params: { id: '123e4567-e89b-42d3-a456-426614174000' },
  };
  const res = responseRecorder();
  auth(req, res, () => undefined);
  await get(req, res, (error) => { throw error; });
  assert.equal(res.statusCode, 404);
  assert.equal(client.releaseCalled, true);
});
