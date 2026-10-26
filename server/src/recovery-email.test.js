/**
 * @file recovery-email.test.js
 * @description Brevo request-shaping tests without network or credential exposure.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createBrevoEmailAdapter } from './recovery-email.js';

test('sends one bounded transactional request using only server-side configuration', async () => {
  let request;
  const adapter = createBrevoEmailAdapter({
    brevoApiKey: 'private-test-key',
    senderEmail: 'verified@example.test',
    senderName: 'Cookie Fluffs',
  }, {
    fetchFn: async (url, options) => {
      request = { url, options };
      return { ok: true };
    },
  });
  await adapter.sendPasswordReset({
    recipient: 'customer@example.test',
    firstName: '<Customer>',
    resetUrl: 'https://cookies.example.test/reset-password?selector=test#token=secret',
  });
  const body = JSON.parse(request.options.body);
  assert.equal(request.url, 'https://api.brevo.com/v3/smtp/email');
  assert.equal(request.options.headers['api-key'], 'private-test-key');
  assert.equal(body.to[0].email, 'customer@example.test');
  assert.equal(body.to[0].contactPixelTrackingConsent, false);
  assert.deepEqual(body.headers, {
    'X-Mailin-track-opens': '0',
    'X-Mailin-track-clicks': '0',
  });
  assert.match(body.htmlContent, /&lt;Customer&gt;/);
  assert.match(body.htmlContent, /Reset password/);
  assert.match(body.htmlContent, /within 30 minutes/i);
  assert.match(body.htmlContent, /password will remain unchanged/i);
  assert.match(body.htmlContent, /background:#fff5f7/);
  assert.doesNotMatch(body.htmlContent, /<img|tracking|pixel/i);
  assert.match(body.textContent, /Reset your Cookie Fluffs password/);
  assert.match(body.textContent, /https:\/\/cookies\.example\.test\/reset-password\?selector=test#token=secret/);
  assert.doesNotMatch(JSON.stringify(body), /private-test-key/);
});

test('escapes untrusted greeting and link content in branded HTML', async () => {
  let payload;
  const adapter = createBrevoEmailAdapter({
    brevoApiKey: 'private-test-key', senderEmail: 'verified@example.test', senderName: 'Cookie Fluffs',
  }, {
    fetchFn: async (_url, options) => {
      payload = JSON.parse(options.body);
      return { ok: true };
    },
  });
  await adapter.sendPasswordReset({
    recipient: 'customer@example.test',
    firstName: '<script>alert(1)</script>\nCustomer',
    resetUrl: 'https://cookies.example.test/reset-password?a=1&b=2#token=safe',
  });
  assert.doesNotMatch(payload.htmlContent, /<script>/);
  assert.match(payload.htmlContent, /&lt;script&gt;/);
  assert.match(payload.htmlContent, /a=1&amp;b=2/);
  assert.doesNotMatch(payload.textContent, /\nCustomer,/);
});
