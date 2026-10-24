/**
 * @file paymongo.test.js
 * @description Hosted Checkout v2 request, URL, method, and test-mode safety tests.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { paymongoConfig, publicPaymentConfig } from './payment-config.js';
import { isTrustedCheckoutUrl, PaymongoAdapter } from './paymongo.js';

const config = paymongoConfig({
  PAYMONGO_SECRET_KEY: 'sk_test_example',
  PAYMONGO_PUBLIC_KEY: 'pk_test_example',
  PAYMONGO_WEBHOOK_SECRET: 'whsec_test',
  PAYMONGO_ENABLED_METHODS: 'gcash,maya,card',
  APP_PUBLIC_URL: 'https://cookies.example.test',
});

test('enables only explicit methods with complete test configuration', () => {
  assert.equal(config.enabled, true);
  assert.deepEqual(publicPaymentConfig(config).methods.map((method) => method.id), ['gcash', 'maya', 'card']);
  assert.equal(paymongoConfig({ PAYMONGO_SECRET_KEY: 'sk_live_nope' }).enabled, false);
  assert.equal(publicPaymentConfig(config).secretKey, undefined);
  assert.equal(publicPaymentConfig(config).publicKey, 'pk_test_example');
  assert.equal(publicPaymentConfig(config).methods.find((method) => method.id === 'card').available, false);
});

test('creates an exact test-mode Payment Intent for an enabled wallet', async () => {
  let request;
  const adapter = new PaymongoAdapter(config, async (url, options) => {
    request = { url, options };
    return { ok: true, json: async () => ({ data: { id: 'pi_test', attributes: {
      client_key: 'pi_test_client_test', livemode: false, status: 'awaiting_payment_method',
    } } }) };
  });
  const result = await adapter.createPaymentIntent({
    attemptId: 'attempt-id', idempotencyKey: '123e4567-e89b-42d3-a456-426614174000',
    order: { id: '223e4567-e89b-42d3-a456-426614174000', paymentMethod: 'maya', total: '188.25', currency: 'PHP' },
  });
  const body = JSON.parse(request.options.body);
  assert.equal(request.url, 'https://api.paymongo.com/v1/payment_intents');
  assert.equal(body.data.attributes.amount, 18_825);
  assert.deepEqual(body.data.attributes.payment_method_allowed, ['paymaya']);
  assert.equal(result.paymentIntentId, 'pi_test');
  assert.equal(JSON.stringify(result).includes(config.secretKey), false);
});

test('keeps card disabled until its compliance model is approved', async () => {
  const adapter = new PaymongoAdapter(config, async () => { throw new Error('Provider should not be called.'); });
  await assert.rejects(() => adapter.createPaymentIntent({
    attemptId: 'attempt-id', idempotencyKey: 'key',
    order: { id: '223e4567-e89b-42d3-a456-426614174000', paymentMethod: 'card', total: '100.00', currency: 'PHP' },
  }), /not enabled/);
});

test('creates an exact-centavo v2 session with provider id and no passed-on fees', async () => {
  let request;
  const adapter = new PaymongoAdapter(config, async (url, options) => {
    request = { url, options };
    return {
      ok: true,
      json: async () => ({ data: { id: 'cs_test', attributes: { checkout_url: 'https://checkout.paymongo.com/cs_test', livemode: false, status: 'active' } } }),
    };
  });
  const result = await adapter.createCheckoutSession({
    attemptId: 'attempt-id',
    idempotencyKey: '123e4567-e89b-42d3-a456-426614174000',
    order: { id: '223e4567-e89b-42d3-a456-426614174000', paymentMethod: 'maya', total: '188.25', currency: 'PHP' },
  });
  const body = JSON.parse(request.options.body);
  assert.equal(request.url, 'https://api.paymongo.com/v2/checkout_sessions');
  assert.deepEqual(body.data.attributes.payment_method_types, ['paymaya']);
  assert.equal(body.data.attributes.line_items[0].amount, 18_825);
  assert.equal(body.data.attributes.pass_on_fees, false);
  assert.equal(request.options.headers['Idempotency-Key'], '123e4567-e89b-42d3-a456-426614174000');
  assert.equal(result.sessionId, 'cs_test');
});

test('accepts only the official HTTPS checkout host and rejects live sessions', async () => {
  assert.equal(isTrustedCheckoutUrl('https://checkout.paymongo.com/cs_test'), true);
  assert.equal(isTrustedCheckoutUrl('https://checkout.paymongo.com.evil.test/cs_test'), false);
  const adapter = new PaymongoAdapter(config, async () => ({
    ok: true,
    json: async () => ({ data: { id: 'cs_live', attributes: { checkout_url: 'https://checkout.paymongo.com/cs_live', livemode: true } } }),
  }));
  await assert.rejects(() => adapter.createCheckoutSession({
    attemptId: 'attempt-id', idempotencyKey: 'key',
    order: { id: '223e4567-e89b-42d3-a456-426614174000', paymentMethod: 'card', total: 100, currency: 'PHP' },
  }), /Live payment sessions/);
});
