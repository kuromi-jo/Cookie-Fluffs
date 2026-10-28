/**
 * @file runtime-config.test.js
 * @description Runtime validation tests for deployment-safe API configuration.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateRuntimeConfig, verificationConfig } from './runtime-config.js';

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
  assert.deepEqual(config.passwordRecovery, { enabled: false });
  assert.deepEqual(config.googleAuth, { enabled: false });
});

test('verification engine works with a pepper while delivery stays off by default', () => {
  // No settings: delivery off, no pepper (engine unavailable).
  assert.deepEqual(verificationConfig({}), { deliveryEnabled: false, pepper: null });
  // Strong pepper alone: engine available, delivery still off (safe for tests/sandbox).
  const withPepper = verificationConfig({ VERIFICATION_CODE_PEPPER: 'verification-pepper-unique-9482-characters-xyz' });
  assert.equal(withPepper.deliveryEnabled, false);
  assert.equal(typeof withPepper.pepper, 'string');
  // A placeholder/weak pepper is not accepted.
  assert.equal(verificationConfig({ VERIFICATION_CODE_PEPPER: 'change-me' }).pepper, null);
  // Enabling delivery requires pepper + verified Brevo sender.
  assert.throws(() => verificationConfig({ VERIFICATION_DELIVERY_ENABLED: 'true' }), /PEPPER/);
  const delivery = verificationConfig({
    VERIFICATION_DELIVERY_ENABLED: 'true',
    VERIFICATION_CODE_PEPPER: 'verification-pepper-unique-9482-characters-xyz',
    BREVO_API_KEY: 'key', BREVO_SENDER_EMAIL: 'sender@example.test', BREVO_SENDER_NAME: 'Cookie Fluffs',
  });
  assert.equal(delivery.deliveryEnabled, true);
});

test('keeps Google authentication disabled by default and validates activation secrets', () => {
  const enabled = {
    GOOGLE_AUTH_ENABLED: 'true',
    GOOGLE_WEB_CLIENT_ID: '123456789-cookie-fluffs.apps.googleusercontent.com',
    GOOGLE_AUTH_NONCE_PEPPER: 'google-nonce-pepper-with-many-unique-characters-4827',
  };
  assert.equal(validateRuntimeConfig(validEnv(enabled)).googleAuth.enabled, true);
  assert.throws(() => validateRuntimeConfig(validEnv({ ...enabled, GOOGLE_WEB_CLIENT_ID: 'android-client' })), /WEB_CLIENT_ID/);
  assert.throws(() => validateRuntimeConfig(validEnv({ ...enabled, GOOGLE_AUTH_NONCE_PEPPER: 'short' })), /NONCE_PEPPER/);
});

test('keeps recovery disabled by default and validates every activation prerequisite', () => {
  const enabled = {
    PASSWORD_RECOVERY_ENABLED: 'true',
    PASSWORD_RESET_TOKEN_PEPPER: 'recovery-test-pepper-with-many-unique-characters-9274',
    BREVO_API_KEY: 'test-brevo-key',
    BREVO_SENDER_EMAIL: 'recovery@example.test',
    BREVO_SENDER_NAME: 'Cookie Fluffs',
    CORS_ALLOWED_ORIGINS: 'https://localhost,https://cookies.example.test',
  };
  assert.equal(validateRuntimeConfig(validEnv(enabled)).passwordRecovery.enabled, true);
  assert.throws(() => validateRuntimeConfig(validEnv({ ...enabled, PASSWORD_RESET_TOKEN_PEPPER: 'short' })), /TOKEN_PEPPER/);
  assert.throws(() => validateRuntimeConfig(validEnv({ ...enabled, BREVO_SENDER_EMAIL: 'not-an-email' })), /BREVO_SENDER_EMAIL/);
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
