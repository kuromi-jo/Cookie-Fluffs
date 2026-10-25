/**
 * @file index.test.js
 * @description API startup separation and fail-closed readiness tests.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './index.js';

test('validates configuration and schema before listening without running migrations', async () => {
  const calls = [];
  const server = await startServer({
    validate: () => { calls.push('validate'); return { port: 3000 }; },
    readiness: async () => calls.push('ready'),
    appFactory: () => { calls.push('app'); return {}; },
    listen: (_app, port) => { calls.push(`listen:${port}`); return 'server'; },
  });
  assert.equal(server, 'server');
  assert.deepEqual(calls, ['validate', 'ready', 'app', 'listen:3000']);
});

test('does not construct or listen when schema readiness fails', async () => {
  let constructed = false;
  let listened = false;
  await assert.rejects(() => startServer({
    validate: () => ({ port: 3000 }),
    readiness: async () => { throw new Error('schema unavailable'); },
    appFactory: () => { constructed = true; },
    listen: () => { listened = true; },
  }), /schema unavailable/);
  assert.equal(constructed, false);
  assert.equal(listened, false);
});
