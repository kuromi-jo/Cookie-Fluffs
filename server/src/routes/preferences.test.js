/**
 * @file preferences.test.js
 * @description Preference defaults, validation, persistence, and ownership tests.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createPreferencesRouter } from './preferences.js';

function handler(router, path, method) {
  const layer = router.stack.find((candidate) => candidate.route?.path === path && candidate.route.methods[method]);
  return layer.route.stack.at(-1).handle;
}

function response() {
  return { statusCode: 200, body: undefined, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
}

test('returns false defaults for an owner without saved preferences', async () => {
  let params;
  const router = createPreferencesRouter(async (_text, values) => { params = values; return { rows: [], rowCount: 0 }; });
  const res = response();
  await handler(router, '/', 'get')({ userId: 12 }, res, (error) => { throw error; });
  assert.deepEqual(params, [12]);
  assert.deepEqual(res.body, { reduceMotion: false, largerText: false, updatedAt: null });
});

test('upserts both boolean preferences for the authenticated owner', async () => {
  let params;
  const saved = { reduceMotion: true, largerText: false, updatedAt: new Date() };
  const router = createPreferencesRouter(async (_text, values) => { params = values; return { rows: [saved], rowCount: 1 }; });
  const res = response();
  await handler(router, '/', 'put')({ userId: 4, body: { reduceMotion: true, largerText: false } }, res, (error) => { throw error; });
  assert.deepEqual(params, [4, true, false]);
  assert.equal(res.body, saved);
});

test('rejects missing, non-boolean, and unknown preference fields before querying', async () => {
  let calls = 0;
  const router = createPreferencesRouter(async () => { calls += 1; return { rows: [], rowCount: 0 }; });
  for (const body of [
    { reduceMotion: true },
    { reduceMotion: 'yes', largerText: false },
    { reduceMotion: true, largerText: false, userId: 2 },
  ]) {
    const res = response();
    await handler(router, '/', 'put')({ userId: 4, body }, res, (error) => { throw error; });
    assert.equal(res.statusCode, 400);
  }
  assert.equal(calls, 0);
});
