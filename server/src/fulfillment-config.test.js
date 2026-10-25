/**
 * @file fulfillment-config.test.js
 * @description Tests fail-closed fulfillment readiness and approved NCR delivery coverage.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { fulfillmentConfig, fulfillmentError } from './fulfillment-config.js';

const configured = (overrides = {}) => fulfillmentConfig({
  APP_ENV: 'demo',
  ORDER_AGREEMENT_REQUIRED: 'true',
  ORDER_AGREEMENT_VERSION: 'draft-2026-10-24-v1',
  FULFILLMENT_DELIVERY_ENABLED: 'true',
  FULFILLMENT_DELIVERY_CITY_CODES: '1381300000',
  FULFILLMENT_PICKUP_ENABLED: 'true',
  FULFILLMENT_PICKUP_LOCATION: 'Configured public test location',
  FULFILLMENT_PICKUP_HOURS: 'Configured test hours',
  ...overrides,
});

test('fails closed when business configuration is missing or malformed', () => {
  const missing = fulfillmentConfig({ APP_ENV: 'production' });
  assert.equal(missing.delivery.enabled, false);
  assert.equal(missing.pickup.enabled, false);
  const malformed = configured({
    FULFILLMENT_DELIVERY_ENABLED: 'yes',
    FULFILLMENT_PICKUP_HOURS: '',
  });
  assert.equal(malformed.delivery.enabled, false);
  assert.equal(malformed.pickup.enabled, false);
});

test('enables configured methods independently of production optimization', () => {
  const config = configured({ APP_ENV: 'production', ORDER_AGREEMENT_REQUIRED: 'false' });
  assert.equal(config.delivery.enabled, true);
  assert.equal(config.pickup.enabled, true);
  assert.deepEqual(config.agreement, { required: false, version: null });
});

test('rejects unknown or partially invalid delivery city configuration', () => {
  assert.equal(configured({ FULFILLMENT_DELIVERY_CITY_CODES: '9999999999' }).delivery.enabled, false);
  assert.equal(configured({ FULFILLMENT_DELIVERY_CITY_CODES: '1381300000,9999999999' }).delivery.enabled, false);
});

test('permits delivery only for an approved canonical city code', () => {
  const config = configured();
  assert.equal(fulfillmentError(config, {
    fulfillmentMethod: 'delivery', deliveryAddress: { cityCode: '1381300000' },
  }), null);
  assert.match(fulfillmentError(config, {
    fulfillmentMethod: 'delivery', deliveryAddress: { cityCode: '1374040000' },
  }), /selected city/i);
});

test('requires configured public pickup location and hours', () => {
  const disabled = configured({ FULFILLMENT_PICKUP_LOCATION: '' });
  assert.match(fulfillmentError(disabled, { fulfillmentMethod: 'pickup' }), /unavailable/i);
  assert.equal(fulfillmentError(configured(), { fulfillmentMethod: 'pickup' }), null);
});
