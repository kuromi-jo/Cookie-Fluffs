/**
 * @file payment-service.test.js
 * @description Payment-session ownership, persistence, idempotency, and recovery tests.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createOrReusePaymentIntent, createOrReusePaymentSession } from './payment-service.js';

const orderId = '123e4567-e89b-42d3-a456-426614174000';
const key = '223e4567-e89b-42d3-a456-426614174000';

function scriptedClient({ order = true, existing = null } = {}) {
  const calls = [];
  return {
    calls,
    async query(text, params = []) {
      const sql = String(text).replace(/\s+/g, ' ').trim();
      calls.push({ sql, params });
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rowCount: null, rows: [] };
      if (sql.startsWith('SELECT id AS "internalId"') && sql.includes('FROM orders')) return order ? {
        rowCount: 1,
        rows: [order === true
          ? { internalId: 7, id: orderId, paymentMethod: 'gcash', paymentStatus: 'awaiting_payment', total: '188.25', currency: 'PHP' }
          : order],
      } : { rowCount: 0, rows: [] };
      if (sql.includes('FROM payment_attempts') && params.length === 1) {
        return { rowCount: 0, rows: [] };
      }
      if (sql.includes('FROM payment_attempts')) return existing
        ? { rowCount: 1, rows: [existing] }
        : { rowCount: 0, rows: [] };
      if (sql.startsWith('INSERT INTO payment_attempts') && sql.includes("'payment_intent'")) return {
        rowCount: 1,
        rows: [{ publicId: '323e4567-e89b-42d3-a456-426614174000', paymentIntentId: null, status: 'creating', idempotencyKey: params[4] }],
      };
      if (sql.startsWith('INSERT INTO payment_attempts')) return {
        rowCount: 1,
        rows: [{ publicId: '323e4567-e89b-42d3-a456-426614174000', checkoutUrl: null, status: 'creating', idempotencyKey: key }],
      };
      if (sql.startsWith('UPDATE payment_attempts') && sql.includes('provider_intent_id')) return {
        rowCount: 1,
        rows: [{ publicId: '323e4567-e89b-42d3-a456-426614174000', paymentIntentId: params[1], status: 'active' }],
      };
      if (sql.startsWith('UPDATE payment_attempts')) return {
        rowCount: 1,
        rows: [{ publicId: '323e4567-e89b-42d3-a456-426614174000', checkoutUrl: params[2], status: 'active' }],
      };
      if (sql.startsWith('UPDATE orders')) return { rowCount: 1, rows: [] };
      throw new Error(`Unexpected SQL: ${sql}`);
    },
  };
}

test('creates one durable attempt and stores the provider session', async () => {
  const client = scriptedClient();
  let received;
  const adapter = {
    async createCheckoutSession(value) {
      received = value;
      return { sessionId: 'cs_test', checkoutUrl: 'https://checkout.paymongo.com/cs_test', status: 'active' };
    },
  };
  const result = await createOrReusePaymentSession(client, 42, orderId, key, adapter);
  assert.equal(result.checkoutUrl, 'https://checkout.paymongo.com/cs_test');
  assert.equal(received.idempotencyKey, key);
  assert.equal(received.order.total, '188.25');
  assert.equal(client.calls.filter((call) => call.sql.startsWith('INSERT INTO payment_attempts')).length, 1);
});

test('creates one durable Payment Intent without returning the secret key', async () => {
  const client = scriptedClient();
  let received;
  const result = await createOrReusePaymentIntent(client, 42, orderId, key, {
    async createPaymentIntent(value) {
      received = value;
      return { paymentIntentId: 'pi_test', clientKey: 'pi_test_client_test', status: 'awaiting_payment_method' };
    },
  });
  assert.equal(received.order.total, '188.25');
  assert.equal(result.paymentIntentId, 'pi_test');
  assert.equal(result.clientKey, 'pi_test_client_test');
  assert.equal(JSON.stringify(result).includes('sk_test_'), false);
});

test('rejects demo orders before any provider call', async () => {
  const client = scriptedClient({ order: {
    internalId: 7,
    id: orderId,
    paymentMethod: 'gcash',
    paymentStatus: 'awaiting_payment',
    paymentIsDemo: true,
    total: '188.25',
    currency: 'PHP',
  } });
  let providerCalled = false;
  await assert.rejects(
    createOrReusePaymentIntent(client, 42, orderId, key, {
      async createPaymentIntent() { providerCalled = true; },
    }),
    (error) => error.status === 409,
  );
  assert.equal(providerCalled, false);
  assert.equal(client.calls.at(-1).sql, 'ROLLBACK');
});

test('recovers the same persisted Payment Intent after interruption', async () => {
  const client = scriptedClient({ existing: {
    publicId: 'attempt', flowType: 'payment_intent', paymentIntentId: 'pi_existing',
    checkoutUrl: null, status: 'active', idempotencyKey: key,
  } });
  let retrieved;
  const result = await createOrReusePaymentIntent(client, 42, orderId, key, {
    async retrievePaymentIntent(id) {
      retrieved = id;
      return { paymentIntentId: id, clientKey: 'client_existing', status: 'awaiting_payment_method' };
    },
  });
  assert.equal(retrieved, 'pi_existing');
  assert.equal(result.paymentIntentId, 'pi_existing');
});

test('returns the validated authorization URL when recovering an awaiting Payment Intent', async () => {
  const existing = {
    publicId: 'attempt', flowType: 'payment_intent', paymentIntentId: 'pi_existing',
    checkoutUrl: null, status: 'active', idempotencyKey: key,
  };
  const client = scriptedClient({ existing });
  let retrieveCount = 0;
  const adapter = {
    async retrievePaymentIntent(id) {
      retrieveCount += 1;
      return {
        paymentIntentId: id,
        clientKey: 'client_existing',
        status: 'awaiting_next_action',
        authorizationUrl: 'https://secure-authentication.paymongo.com/sources',
      };
    },
  };

  const first = await createOrReusePaymentIntent(client, 42, orderId, key, adapter);
  const second = await createOrReusePaymentIntent(client, 42, orderId, key, adapter);

  assert.equal(first.authorizationUrl, 'https://secure-authentication.paymongo.com/sources');
  assert.equal(second.authorizationUrl, first.authorizationUrl);
  assert.equal(first.paymentIntentId, 'pi_existing');
  assert.equal(second.paymentIntentId, 'pi_existing');
  assert.equal(retrieveCount, 2);
  assert.equal(client.calls.some((call) => call.sql.startsWith('INSERT INTO payment_attempts')), false);
});

test('does not return an authorization URL for an ineligible Payment Intent state', async () => {
  const client = scriptedClient({ existing: {
    publicId: 'attempt', flowType: 'payment_intent', paymentIntentId: 'pi_existing',
    checkoutUrl: null, status: 'active', idempotencyKey: key,
  } });
  const result = await createOrReusePaymentIntent(client, 42, orderId, key, {
    async retrievePaymentIntent(id) {
      return {
        paymentIntentId: id,
        clientKey: 'client_existing',
        status: 'processing',
        authorizationUrl: 'https://secure-authentication.paymongo.com/sources',
      };
    },
  });

  assert.equal(result.authorizationUrl, undefined);
});

test('requires a fresh key only after a signed failure agrees with provider state', async () => {
  const client = scriptedClient({ existing: {
    internalId: 9, publicId: 'attempt', flowType: 'payment_intent', paymentIntentId: 'pi_failed',
    checkoutUrl: null, status: 'failed', idempotencyKey: key,
  } });

  await assert.rejects(
    () => createOrReusePaymentIntent(client, 42, orderId, key, {
      async retrievePaymentIntent(id) {
        return { paymentIntentId: id, clientKey: 'client_failed', status: 'awaiting_payment_method' };
      },
    }),
    (error) => error.status === 410 && error.code === 'PAYMENT_ATTEMPT_FAILED',
  );
  assert.equal(client.calls.some((call) => call.sql.startsWith('INSERT INTO payment_attempts')), false);
});

test('keeps an ambiguous failed attempt on its existing Payment Intent', async () => {
  const client = scriptedClient({ existing: {
    internalId: 9, publicId: 'attempt', flowType: 'payment_intent', paymentIntentId: 'pi_pending',
    checkoutUrl: null, status: 'failed', idempotencyKey: key,
  } });
  const result = await createOrReusePaymentIntent(client, 42, orderId, key, {
    async retrievePaymentIntent(id) {
      return {
        paymentIntentId: id, clientKey: 'client_pending', status: 'awaiting_next_action',
        authorizationUrl: 'https://secure-authentication.paymongo.com/sources',
      };
    },
  });

  assert.equal(result.paymentIntentId, 'pi_pending');
  assert.equal(result.authorizationUrl, 'https://secure-authentication.paymongo.com/sources');
  assert.equal(client.calls.some((call) => call.sql.startsWith('INSERT INTO payment_attempts')), false);
});

test('creates one fresh attempt after confirmed failure and an explicit new key', async () => {
  const retryKey = '423e4567-e89b-42d3-a456-426614174000';
  const client = scriptedClient({ existing: {
    internalId: 9, publicId: 'failed-attempt', flowType: 'payment_intent', paymentIntentId: 'pi_failed',
    checkoutUrl: null, status: 'failed', idempotencyKey: key,
  } });
  const created = [];
  const result = await createOrReusePaymentIntent(client, 42, orderId, retryKey, {
    async retrievePaymentIntent(id) {
      return { paymentIntentId: id, clientKey: 'client_failed', status: 'awaiting_payment_method' };
    },
    async createPaymentIntent(value) {
      created.push(value);
      return { paymentIntentId: 'pi_retry', clientKey: 'client_retry', status: 'awaiting_payment_method' };
    },
  });

  assert.equal(result.paymentIntentId, 'pi_retry');
  assert.equal(created.length, 1);
  assert.equal(created[0].idempotencyKey, retryKey);
  assert.equal(client.calls.filter((call) => call.sql.startsWith('INSERT INTO payment_attempts')).length, 1);
});

test('does not replace a failed attempt when provider reconciliation is unavailable', async () => {
  const client = scriptedClient({ existing: {
    internalId: 9, publicId: 'attempt', flowType: 'payment_intent', paymentIntentId: 'pi_failed',
    checkoutUrl: null, status: 'failed', idempotencyKey: key,
  } });
  await assert.rejects(
    () => createOrReusePaymentIntent(client, 42, orderId, key, {
      async retrievePaymentIntent() { throw new Error('Provider timeout'); },
    }),
    /Provider timeout/,
  );
  assert.equal(client.calls.some((call) => call.sql.startsWith('INSERT INTO payment_attempts')), false);
});

test('rejects another payment attempt for an already-paid order', async () => {
  const client = scriptedClient({ order: {
    internalId: 7, id: orderId, paymentMethod: 'gcash', paymentStatus: 'paid', total: '188.25', currency: 'PHP',
  } });
  let providerCalled = false;

  await assert.rejects(
    () => createOrReusePaymentIntent(client, 42, orderId, key, {
      async createPaymentIntent() { providerCalled = true; },
    }),
    (error) => error.status === 409 && /already paid/i.test(error.message),
  );
  assert.equal(providerCalled, false);
  assert.equal(client.calls.some((call) => call.sql.startsWith('INSERT INTO payment_attempts')), false);
});

test('reuses an active session without another provider call', async () => {
  const client = scriptedClient({
    existing: { publicId: 'attempt', checkoutUrl: 'https://checkout.paymongo.com/cs_existing', status: 'active', idempotencyKey: key },
  });
  const adapter = { createCheckoutSession: async () => { throw new Error('Provider should not be called.'); } };
  const result = await createOrReusePaymentSession(client, 42, orderId, key, adapter);
  assert.equal(result.checkoutUrl, 'https://checkout.paymongo.com/cs_existing');
});

test('requires a new key after a confirmed expired session', async () => {
  const client = scriptedClient({
    existing: { publicId: 'attempt', checkoutUrl: 'https://checkout.paymongo.com/cs_expired', status: 'expired', idempotencyKey: key },
  });
  let providerCalled = false;
  await assert.rejects(
    () => createOrReusePaymentSession(client, 42, orderId, key, {
      async createCheckoutSession() { providerCalled = true; },
    }),
    (error) => error.status === 410,
  );
  assert.equal(providerCalled, false);
});

test('does not reveal or create a payment for an unowned order', async () => {
  const client = scriptedClient({ order: false });
  await assert.rejects(
    () => createOrReusePaymentSession(client, 99, orderId, key, {}),
    (error) => error.status === 404,
  );
  assert.equal(client.calls.some((call) => call.sql.startsWith('INSERT INTO payment_attempts')), false);
});
