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
  agreementAccepted: true,
  agreementVersion: 'draft-2026-10-24-v1',
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

test('submits an owner-scoped cancellation request with only an idempotency key', async () => {
  const client = { releaseCalled: false, release() { this.releaseCalled = true; } };
  let received;
  const orderActions = {
    createOrder: async () => null,
    async requestOrderCancellation(_client, userId, id, idempotencyKey) {
      received = { userId, id, idempotencyKey };
    },
    async getOrderByPublicId() {
      return { id: '123e4567-e89b-42d3-a456-426614174000', orderStatus: 'cancelled' };
    },
  };
  const router = createOrdersRouter({ connect: async () => client }, orderActions);
  const auth = router.stack.find((layer) => !layer.route).handle;
  const cancel = router.stack.find(
    (layer) => layer.route?.path === '/:id/cancellation-requests' && layer.route.methods.post,
  ).route.stack[0].handle;
  const req = {
    headers: { authorization: `Bearer ${signToken(42)}` },
    params: { id: '123e4567-e89b-42d3-a456-426614174000' },
    body: { idempotencyKey: '223e4567-e89b-42d3-a456-426614174000' },
  };
  const res = responseRecorder();
  auth(req, res, () => undefined);
  await cancel(req, res, (error) => { throw error; });
  assert.deepEqual(received, { userId: 42, id: req.params.id, idempotencyKey: req.body.idempotencyKey });
  assert.equal(res.body.orderStatus, 'cancelled');
  assert.equal(client.releaseCalled, true);
});

test('rejects cancellation request field injection before database work', async () => {
  let connected = false;
  const router = createOrdersRouter({ connect: async () => { connected = true; } });
  const auth = router.stack.find((layer) => !layer.route).handle;
  const cancel = router.stack.find(
    (layer) => layer.route?.path === '/:id/cancellation-requests' && layer.route.methods.post,
  ).route.stack[0].handle;
  const req = {
    headers: { authorization: `Bearer ${signToken(42)}` },
    params: { id: '123e4567-e89b-42d3-a456-426614174000' },
    body: { idempotencyKey: '223e4567-e89b-42d3-a456-426614174000', orderStatus: 'cancelled' },
  };
  const res = responseRecorder();
  auth(req, res, () => undefined);
  await cancel(req, res, (error) => { throw error; });
  assert.equal(res.statusCode, 400);
  assert.equal(connected, false);
});

test('returns bounded owner-scoped order history', async () => {
  const client = { releaseCalled: false, release() { this.releaseCalled = true; } };
  let received;
  const orderActions = {
    createOrder: async () => null,
    getOrderByPublicId: async () => null,
    async listOrders(_client, userId, options) {
      received = { userId, options };
      return { orders: [], nextCursor: null };
    },
  };
  const router = createOrdersRouter({ connect: async () => client }, orderActions);
  const auth = router.stack.find((layer) => !layer.route).handle;
  const list = router.stack.find((layer) => layer.route?.path === '/' && layer.route.methods.get).route.stack[0].handle;
  const req = { headers: { authorization: `Bearer ${signToken(42)}` }, query: { limit: '12', cursor: 'opaque' } };
  const res = responseRecorder();
  auth(req, res, () => undefined);
  await list(req, res, (error) => { throw error; });
  assert.deepEqual(received, { userId: 42, options: { limit: 12, cursor: 'opaque' } });
  assert.deepEqual(res.body, { orders: [], nextCursor: null });
  assert.equal(client.releaseCalled, true);
});

test('rejects unbounded order-history page sizes before database work', async () => {
  let connected = false;
  const router = createOrdersRouter({ connect: async () => { connected = true; } });
  const auth = router.stack.find((layer) => !layer.route).handle;
  const list = router.stack.find((layer) => layer.route?.path === '/' && layer.route.methods.get).route.stack[0].handle;
  const req = { headers: { authorization: `Bearer ${signToken(42)}` }, query: { limit: '100' } };
  const res = responseRecorder();
  auth(req, res, () => undefined);
  await list(req, res, (error) => { throw error; });
  assert.equal(res.statusCode, 400);
  assert.equal(connected, false);
});

test('rejects online order creation when test payments are not configured', async () => {
  const { auth, post } = layers();
  const req = {
    headers: { authorization: `Bearer ${signToken(42)}` },
    body: { ...validCheckout, paymentMethod: 'gcash' },
  };
  const res = responseRecorder();
  auth(req, res, () => undefined);
  await post(req, res, (error) => { throw error; });
  assert.equal(res.statusCode, 409);
  assert.match(res.body.message, /not available/);
});

test('creates a payment session for the authenticated order with only a UUID key', async () => {
  const client = { releaseCalled: false, release() { this.releaseCalled = true; } };
  const dbPool = { connect: async () => client };
  let received;
  const orderActions = {
    createOrder: async () => null,
    getOrderByPublicId: async () => null,
    async createOrReusePaymentSession(_client, userId, orderId, idempotencyKey) {
      received = { userId, orderId, idempotencyKey };
      return { attemptId: 'attempt', checkoutUrl: 'https://checkout.paymongo.com/cs_test', status: 'active' };
    },
  };
  const paymentAdapter = { config: { enabled: true, methods: [{ id: 'gcash' }] } };
  const router = createOrdersRouter(dbPool, orderActions, paymentAdapter);
  const auth = router.stack.find((layer) => !layer.route).handle;
  const payment = router.stack.find(
    (layer) => layer.route?.path === '/:id/payment-session' && layer.route.methods.post,
  ).route.stack[0].handle;
  const req = {
    headers: { authorization: `Bearer ${signToken(42)}` },
    params: { id: '123e4567-e89b-42d3-a456-426614174000' },
    body: { idempotencyKey: '223e4567-e89b-42d3-a456-426614174000' },
  };
  const res = responseRecorder();
  auth(req, res, () => undefined);
  await payment(req, res, (error) => { throw error; });
  assert.deepEqual(received, { userId: 42, orderId: req.params.id, idempotencyKey: req.body.idempotencyKey });
  assert.equal(res.statusCode, 200);
  assert.equal(client.releaseCalled, true);
});

test('creates an owned Payment Intent with only a UUID key', async () => {
  const client = { releaseCalled: false, release() { this.releaseCalled = true; } };
  let received;
  const orderActions = {
    createOrder: async () => null,
    getOrderByPublicId: async () => null,
    async createOrReusePaymentIntent(_client, userId, orderId, idempotencyKey) {
      received = { userId, orderId, idempotencyKey };
      return { flow: 'payment_intent', attemptId: 'attempt', paymentIntentId: 'pi_test', clientKey: 'client_test' };
    },
  };
  const router = createOrdersRouter({ connect: async () => client }, orderActions, {
    config: { enabled: true, methods: [{ id: 'gcash' }] },
  });
  const auth = router.stack.find((layer) => !layer.route).handle;
  const payment = router.stack.find(
    (layer) => layer.route?.path === '/:id/payment-intent' && layer.route.methods.post,
  ).route.stack[0].handle;
  const req = {
    headers: { authorization: `Bearer ${signToken(42)}` },
    params: { id: '123e4567-e89b-42d3-a456-426614174000' },
    body: { idempotencyKey: '223e4567-e89b-42d3-a456-426614174000' },
  };
  const res = responseRecorder();
  auth(req, res, () => undefined);
  await payment(req, res, (error) => { throw error; });
  assert.deepEqual(received, { userId: 42, orderId: req.params.id, idempotencyKey: req.body.idempotencyKey });
  assert.equal(res.body.clientKey, 'client_test');
  assert.equal(client.releaseCalled, true);
});

test('returns a machine-readable 410 only for a confirmed failed payment attempt', async () => {
  const client = { releaseCalled: false, release() { this.releaseCalled = true; } };
  const error = Object.assign(new Error('This payment attempt failed.'), {
    status: 410,
    code: 'PAYMENT_ATTEMPT_FAILED',
  });
  const orderActions = {
    createOrder: async () => null,
    getOrderByPublicId: async () => null,
    createOrReusePaymentIntent: async () => { throw error; },
  };
  const router = createOrdersRouter({ connect: async () => client }, orderActions, {
    config: { enabled: true, methods: [{ id: 'maya' }] },
  });
  const auth = router.stack.find((layer) => !layer.route).handle;
  const payment = router.stack.find(
    (layer) => layer.route?.path === '/:id/payment-intent' && layer.route.methods.post,
  ).route.stack[0].handle;
  const req = {
    headers: { authorization: `Bearer ${signToken(42)}` },
    params: { id: '123e4567-e89b-42d3-a456-426614174000' },
    body: { idempotencyKey: '223e4567-e89b-42d3-a456-426614174000' },
  };
  const res = responseRecorder();
  auth(req, res, () => undefined);
  await payment(req, res, (caught) => { throw caught; });

  assert.equal(res.statusCode, 410);
  assert.deepEqual(res.body, { message: error.message, code: 'PAYMENT_ATTEMPT_FAILED' });
  assert.equal(client.releaseCalled, true);
});

test('runs an authenticated card demo with only a scenario and UUID key', async () => {
  const client = { releaseCalled: false, release() { this.releaseCalled = true; } };
  let received;
  const orderActions = {
    createOrder: async () => null,
    getOrderByPublicId: async () => null,
    async processDemoCard(_client, userId, orderId, idempotencyKey, scenario) {
      received = { userId, orderId, idempotencyKey, scenario };
      return { attemptId: 'demo-attempt', scenario, status: 'demo_approved', isDemo: true };
    },
  };
  const router = createOrdersRouter(
    { connect: async () => client },
    orderActions,
    { config: { enabled: false, methods: [] } },
    { enabled: true, production: false },
  );
  const auth = router.stack.find((layer) => !layer.route).handle;
  const demo = router.stack.find(
    (layer) => layer.route?.path === '/:id/demo-card' && layer.route.methods.post,
  ).route.stack[0].handle;
  const req = {
    headers: { authorization: `Bearer ${signToken(42)}` },
    params: { id: '123e4567-e89b-42d3-a456-426614174000' },
    body: {
      idempotencyKey: '223e4567-e89b-42d3-a456-426614174000',
      scenario: 'visa_approved',
    },
  };
  const res = responseRecorder();
  auth(req, res, () => undefined);
  await demo(req, res, (error) => { throw error; });
  assert.deepEqual(received, { userId: 42, orderId: req.params.id, ...req.body });
  assert.equal(res.body.status, 'demo_approved');
  assert.equal(client.releaseCalled, true);
});

test('rejects card-demo credentials and production demo access before database work', async () => {
  let connected = false;
  const router = createOrdersRouter(
    { connect: async () => { connected = true; } },
    {},
    { config: { enabled: false, methods: [] } },
    { enabled: false, production: true },
  );
  const auth = router.stack.find((layer) => !layer.route).handle;
  const demo = router.stack.find(
    (layer) => layer.route?.path === '/:id/demo-card' && layer.route.methods.post,
  ).route.stack[0].handle;
  const req = {
    headers: { authorization: `Bearer ${signToken(42)}` },
    params: { id: '123e4567-e89b-42d3-a456-426614174000' },
    body: {
      idempotencyKey: '223e4567-e89b-42d3-a456-426614174000',
      scenario: 'visa_approved',
      cvc: '123',
    },
  };
  const res = responseRecorder();
  auth(req, res, () => undefined);
  await demo(req, res, (error) => { throw error; });
  assert.equal(res.statusCode, 404);
  assert.equal(connected, false);
});

test('rejects unsupported card-demo scenarios before database work', async () => {
  let connected = false;
  const router = createOrdersRouter(
    { connect: async () => { connected = true; } },
    {},
    { config: { enabled: false, methods: [] } },
    { enabled: true, production: false },
  );
  const auth = router.stack.find((layer) => !layer.route).handle;
  const demo = router.stack.find(
    (layer) => layer.route?.path === '/:id/demo-card' && layer.route.methods.post,
  ).route.stack[0].handle;
  const req = {
    headers: { authorization: `Bearer ${signToken(42)}` },
    params: { id: '123e4567-e89b-42d3-a456-426614174000' },
    body: {
      idempotencyKey: '223e4567-e89b-42d3-a456-426614174000',
      scenario: 'unknown_card',
    },
  };
  const res = responseRecorder();
  auth(req, res, () => undefined);
  await demo(req, res, (error) => { throw error; });
  assert.equal(res.statusCode, 400);
  assert.equal(connected, false);
});

test('rejects sensitive card fields while the demo endpoint is enabled', async () => {
  let connected = false;
  const router = createOrdersRouter(
    { connect: async () => { connected = true; } },
    {},
    { config: { enabled: false, methods: [] } },
    { enabled: true, production: false },
  );
  const auth = router.stack.find((layer) => !layer.route).handle;
  const demo = router.stack.find(
    (layer) => layer.route?.path === '/:id/demo-card' && layer.route.methods.post,
  ).route.stack[0].handle;
  const req = {
    headers: { authorization: `Bearer ${signToken(42)}` },
    params: { id: '123e4567-e89b-42d3-a456-426614174000' },
    body: {
      idempotencyKey: '223e4567-e89b-42d3-a456-426614174000',
      scenario: 'visa_approved',
      cardNumber: 'synthetic-value-must-not-reach-the-service',
    },
  };
  const res = responseRecorder();
  auth(req, res, () => undefined);
  await demo(req, res, (error) => { throw error; });
  assert.equal(res.statusCode, 400);
  assert.equal(connected, false);
});

test('runs an authenticated wallet demo with only an action and UUID key', async () => {
  const client = { releaseCalled: false, release() { this.releaseCalled = true; } };
  let received;
  const orderActions = {
    async processDemoWallet(_client, userId, orderId, idempotencyKey, action) {
      received = { userId, orderId, idempotencyKey, action };
      return { attemptId: 'wallet-attempt', walletMethod: 'gcash', status: 'demo_approved', isDemo: true };
    },
  };
  const router = createOrdersRouter(
    { connect: async () => client },
    orderActions,
    { config: { enabled: false, methods: [] } },
    { enabled: false, production: false },
    { enabled: true, production: false },
  );
  const auth = router.stack.find((layer) => !layer.route).handle;
  const demo = router.stack.find(
    (layer) => layer.route?.path === '/:id/demo-wallet' && layer.route.methods.post,
  ).route.stack[0].handle;
  const req = {
    headers: { authorization: `Bearer ${signToken(42)}` },
    params: { id: '123e4567-e89b-42d3-a456-426614174000' },
    body: { idempotencyKey: '223e4567-e89b-42d3-a456-426614174000', action: 'confirm' },
  };
  const res = responseRecorder();
  auth(req, res, () => undefined);
  await demo(req, res, (error) => { throw error; });
  assert.deepEqual(received, { userId: 42, orderId: req.params.id, ...req.body });
  assert.equal(res.body.status, 'demo_approved');
  assert.equal(client.releaseCalled, true);
});

test('rejects wallet credentials and production wallet demos before database work', async () => {
  let connected = false;
  const router = createOrdersRouter(
    { connect: async () => { connected = true; } },
    {},
    { config: { enabled: false, methods: [] } },
    { enabled: false, production: false },
    { enabled: true, production: false },
  );
  const auth = router.stack.find((layer) => !layer.route).handle;
  const demo = router.stack.find(
    (layer) => layer.route?.path === '/:id/demo-wallet' && layer.route.methods.post,
  ).route.stack[0].handle;
  const req = {
    headers: { authorization: `Bearer ${signToken(42)}` },
    params: { id: '123e4567-e89b-42d3-a456-426614174000' },
    body: {
      idempotencyKey: '223e4567-e89b-42d3-a456-426614174000',
      action: 'confirm',
      otp: 'must-never-be-accepted',
    },
  };
  const res = responseRecorder();
  auth(req, res, () => undefined);
  await demo(req, res, (error) => { throw error; });
  assert.equal(res.statusCode, 400);
  assert.equal(connected, false);
});
