/**
 * @file cors-config.test.js
 * @description Verifies that browser API access is restricted to trusted web and Capacitor origins.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { allowedCorsOrigins, corsOptions } from './cors-config.js';

test('allows only built-in and explicitly configured origins', () => {
  const allowed = allowedCorsOrigins({ CORS_ALLOWED_ORIGINS: 'https://cookies.example.test' });
  assert.equal(allowed.has('http://localhost:4200'), true);
  assert.equal(allowed.has('https://localhost'), true);
  assert.equal(allowed.has('https://cookies.example.test'), true);
  assert.equal(allowed.has('https://untrusted.example.test'), false);
});

test('permits non-browser requests and withholds CORS from untrusted origins', () => {
  const options = corsOptions({});
  const check = (origin) => new Promise((resolve) => options.origin(origin, (_error, result) => resolve(result)));

  return Promise.all([
    check(undefined).then((result) => assert.equal(result, true)),
    check('https://localhost').then((result) => assert.equal(result, true)),
    check('https://untrusted.example.test').then((result) => assert.equal(result, false)),
  ]);
});
