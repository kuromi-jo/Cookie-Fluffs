/**
 * @file migrate.test.js
 * @description Explicit migration command orchestration and failure tests.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { runMigrationCommand } from './migrate.js';

test('validates, migrates, verifies readiness and closes in order', async () => {
  const calls = [];
  await runMigrationCommand({
    validate: () => calls.push('validate'),
    migrate: async () => calls.push('migrate'),
    readiness: async () => calls.push('ready'),
    close: async () => calls.push('close'),
  });
  assert.deepEqual(calls, ['validate', 'migrate', 'ready', 'close']);
});

test('returns migration failures to the command boundary', async () => {
  let closed = false;
  await assert.rejects(() => runMigrationCommand({
    validate: () => undefined,
    migrate: async () => { throw new Error('controlled failure'); },
    readiness: async () => undefined,
    close: async () => { closed = true; },
  }), /controlled failure/);
  assert.equal(closed, true);
});
