/**
 * @file password-recovery-service.test.js
 * @description Disabled-mode and privacy-boundary tests for password recovery.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPasswordRecoveryService, passwordRecoveryLimits } from './password-recovery-service.js';

test('disabled recovery never connects to PostgreSQL or email', async () => {
  let connected = false;
  let emailed = false;
  const service = createPasswordRecoveryService({
    config: { enabled: false },
    databasePool: { connect: async () => { connected = true; } },
    emailAdapter: { sendPasswordReset: async () => { emailed = true; } },
  });
  assert.deepEqual(service.config(), { enabled: false });
  assert.deepEqual(await service.requestReset('customer@example.test', '127.0.0.1'), { kind: 'disabled' });
  assert.deepEqual(await service.resetPassword('selector', 'token', 'Password1!'), { kind: 'disabled' });
  assert.equal(connected, false);
  assert.equal(emailed, false);
});

test('published recovery limits match the approved policy', () => {
  assert.deepEqual(passwordRecoveryLimits, {
    tokenMinutes: 30,
    emailRequestsPerHour: 3,
    ipRequestsPerHour: 10,
    tokenFailures: 5,
  });
});
