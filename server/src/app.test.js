/**
 * @file app.test.js
 * @description Liveness, readiness and sanitized health endpoint tests.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { livenessHandler, readinessHandler } from './app.js';

function responseRecorder() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

test('liveness does not depend on database readiness', async () => {
  const response = responseRecorder();
  livenessHandler({}, response);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, { ok: true });
});

test('readiness and legacy health return sanitized unavailable responses', async () => {
  const response = responseRecorder();
  await readinessHandler(async () => { throw new Error('postgresql://private-host/database'); })({}, response);
  assert.equal(response.statusCode, 503);
  assert.deepEqual(response.body, { ok: false });
  assert.doesNotMatch(JSON.stringify(response.body), /postgres|private|database/i);
});

test('readiness succeeds only after its dependency check passes', async () => {
  const response = responseRecorder();
  await readinessHandler(async () => ({ ready: true }))({}, response);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, { ok: true });
});
