/**
 * @file demo-payment-config.test.js
 * @description Card-demo environment gate and public capability tests.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { addDemoCardCapability, demoPaymentConfig } from './demo-payment-config.js';

const base = {
  onlineEnabled: false,
  mode: 'disabled',
  publicKey: '',
  methods: [],
  unavailableMessage: 'Unavailable.',
};

test('enables the card demo only through an explicit nonproduction switch', () => {
  assert.deepEqual(demoPaymentConfig({ CARD_DEMO_ENABLED: 'true', NODE_ENV: 'development' }), {
    enabled: true,
    production: false,
  });
  assert.equal(demoPaymentConfig({ CARD_DEMO_ENABLED: 'true', NODE_ENV: 'production' }).enabled, false);
  assert.equal(demoPaymentConfig({ NODE_ENV: 'test' }).enabled, false);
});

test('publishes only a labeled demo capability and no secret configuration', () => {
  const result = addDemoCardCapability(base, { enabled: true, production: false });
  assert.equal(result.cardDemoEnabled, true);
  assert.deepEqual(result.methods[0], {
    id: 'card', label: 'Credit / Debit Card', available: true, unavailableMessage: '', demo: true,
  });
  assert.doesNotMatch(JSON.stringify(result), /secret|private|cvc|cardNumber/i);
});
