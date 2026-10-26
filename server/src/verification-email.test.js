/**
 * @file verification-email.test.js
 * @description Unit tests for the Brevo verification adapter's delivery-outcome typing: a
 * completed non-2xx response is a CONFIRMED rejection; an aborted/network error is AMBIGUOUS.
 * Also asserts the raw code never leaks into the thrown error, and the email body carries the
 * code, the 10-minute expiry, and Cookie Fluffs branding. No real network is used.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  VerificationDeliveryError,
  createBrevoVerificationAdapter,
} from './verification-email.js';

const config = { brevoApiKey: 'key-test', senderEmail: 'security@cookiefluffs.test', senderName: 'Cookie Fluffs' };
const message = { recipient: 'user@example.test', firstName: 'Mara', code: '135790', operation: 'change_phone' };

test('a completed non-2xx response is a CONFIRMED rejection', async () => {
  const adapter = createBrevoVerificationAdapter(config, { fetchFn: async () => ({ ok: false, status: 400 }) });
  await assert.rejects(
    () => adapter.sendVerificationCode(message),
    (err) => {
      assert.ok(err instanceof VerificationDeliveryError);
      assert.equal(err.outcome, 'rejected');
      assert.equal(err.message.includes('135790'), false); // never leak the OTP
      return true;
    },
  );
});

test('a transport/abort error is AMBIGUOUS (the provider may have accepted it)', async () => {
  const adapter = createBrevoVerificationAdapter(config, {
    fetchFn: async () => { throw new Error('socket hang up'); },
  });
  await assert.rejects(
    () => adapter.sendVerificationCode(message),
    (err) => {
      assert.ok(err instanceof VerificationDeliveryError);
      assert.equal(err.outcome, 'ambiguous');
      assert.equal(err.message.includes('135790'), false);
      return true;
    },
  );
});

test('a 2xx response resolves without error and sends the branded code + expiry', async () => {
  let captured;
  const adapter = createBrevoVerificationAdapter(config, {
    fetchFn: async (_url, init) => { captured = JSON.parse(init.body); return { ok: true, status: 201 }; },
  });
  await adapter.sendVerificationCode(message);
  assert.equal(captured.sender.email, config.senderEmail);
  assert.equal(captured.sender.name, 'Cookie Fluffs');
  assert.equal(captured.to[0].email, message.recipient);
  assert.ok(captured.htmlContent.includes('135790'));
  assert.ok(captured.htmlContent.includes('Cookie Fluffs'));
  assert.ok(captured.htmlContent.includes('10 minutes'));
  assert.ok(captured.textContent.includes('135790'));
  assert.ok(captured.textContent.includes('10 minutes'));
});

test('the HTML body escapes a hostile first name (no injection)', async () => {
  let captured;
  const adapter = createBrevoVerificationAdapter(config, {
    fetchFn: async (_url, init) => { captured = JSON.parse(init.body); return { ok: true, status: 201 }; },
  });
  await adapter.sendVerificationCode({ ...message, firstName: '<script>alert(1)</script>' });
  assert.equal(captured.htmlContent.includes('<script>'), false);
  assert.ok(captured.htmlContent.includes('&lt;script&gt;'));
});
