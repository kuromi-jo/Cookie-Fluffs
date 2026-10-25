/**
 * @file runtime-config.test.js
 * @description Runtime validation tests for deployment-safe API configuration.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateRuntimeConfig } from './runtime-config.js';

const validEnv = (overrides = {}) => ({
  APP_ENV: 'demo',
  NODE_ENV: 'production',
  PORT: '3000',
  DATABASE_URL: 'postgresql://user:password@127.0.0.1:55432/cookie_fluffs_test',
  JWT_SECRET: 'test-runtime-secret-with-32-unique-characters-9482',
  CORS_ALLOWED_ORIGINS: 'https://localhost,https://api.example.test',
  ORDER_AGREEMENT_REQUIRED: 'true',
  ORDER_AGREEMENT_VERSION: 'draft-2026-10-24-v1',
  FULFILLMENT_DELIVERY_ENABLED: 'true',
  FULFILLMENT_DELIVERY_CITY_CODES: '1381300000',
  FULFILLMENT_PICKUP_ENABLED: 'false',
  CARD_DEMO_ENABLED: 'true',
  WALLET_DEMO_ENABLED: 'false',
  ...overrides,
});

test('accepts an explicit hosted demo configuration without exposing secret values', () => {
  const config = validateRuntimeConfig(validEnv());
  assert.equal(config.appEnv, 'demo');
  assert.equal(config.fulfillment.delivery.enabled, true);
  assert.deepEqual(config.agreement, { required: true, version: 'draft-2026-10-24-v1' });
});

test('rejects missing, weak and placeholder JWT secrets', () => {
  for (const JWT_SECRET of ['', 'short', 'change-me-to-a-long-random-string']) {
    assert.throws(() => validateRuntimeConfig(validEnv({ JWT_SECRET })), /JWT_SECRET/);
  }
});

test('rejects invalid runtime, CORS and fulfillment configuration', () => {
  assert.throws(() => validateRuntimeConfig(validEnv({ APP_ENV: 'staging' })), /APP_ENV/);
  assert.throws(() => validateRuntimeConfig(validEnv({ CORS_ALLOWED_ORIGINS: '*' })), /CORS_ALLOWED_ORIGINS/);
  assert.throws(() => validateRuntimeConfig(validEnv({ FULFILLMENT_DELIVERY_CITY_CODES: 'invalid' })), /delivery/i);
});

test('rejects production demo switches and draft agreement versions', () => {
  assert.throws(() => validateRuntimeConfig(validEnv({ APP_ENV: 'production' })), /draft/i);
  assert.throws(() => validateRuntimeConfig(validEnv({
    APP_ENV: 'production',
    ORDER_AGREEMENT_VERSION: 'terms-v1',
  })), /demonstrations/i);
});
