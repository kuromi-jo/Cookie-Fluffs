/**
 * @file auth.test.js
 * @description Route-level checks for signup enforcement and legacy login compatibility.
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import pg from 'pg';

process.env.DATABASE_URL = 'postgresql://test:test@localhost/test';
process.env.JWT_SECRET = 'test-only-cookie-fluffs-secret-9482';

const legacyPassword = 'legacy1';
const legacyHash = await bcrypt.hash(legacyPassword, 4);
const originalQuery = pg.Pool.prototype.query;
pg.Pool.prototype.query = async (text) => {
  if (text.startsWith('SELECT * FROM users WHERE email')) {
    return {
      rows: [{
        id: 1,
        first_name: null,
        last_name: null,
        full_name: 'Legacy User',
        email: 'legacy@example.com',
        phone: '+639171234567',
        avatar: null,
        password_hash: legacyHash,
        created_at: new Date('2025-01-01T00:00:00Z'),
      }],
    };
  }
  throw new Error(`Unexpected test query: ${text}`);
};

const { createAuthRouter, default: router } = await import('./auth.js');
const { pool } = await import('../db.js');

after(async () => {
  pg.Pool.prototype.query = originalQuery;
  await pool?.end();
});

function routeHandler(path) {
  const layer = router.stack.find((candidate) => candidate.route?.path === path);
  assert.ok(layer, `Expected ${path} route`);
  return layer.route.stack[0].handle;
}

function authenticatedRouteHandler(testRouter, path, method) {
  const layer = testRouter.stack.find((candidate) => candidate.route?.path === path && candidate.route.methods[method]);
  assert.ok(layer, `Expected ${method.toUpperCase()} ${path} route`);
  return layer.route.stack.at(-1).handle;
}

function responseRecorder() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

test('signup route rejects a password that bypasses frontend validation', async () => {
  const req = {
    body: {
      firstName: 'Maria',
      lastName: 'Santos',
      email: 'maria@example.com',
      phone: '0917 123 4567',
      password: 'lowercase1!',
    },
  };
  const res = responseRecorder();

  await routeHandler('/signup')(req, res, (error) => { throw error; });

  assert.equal(res.statusCode, 400);
  assert.match(res.body.errors.password, /uppercase/);
});

test('login route still accepts an existing password that predates the signup policy', async () => {
  const req = { body: { email: 'legacy@example.com', password: legacyPassword } };
  const res = responseRecorder();

  await routeHandler('/login')(req, res, (error) => { throw error; });

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.user.email, 'legacy@example.com');
  assert.equal(typeof res.body.token, 'string');
});

test('profile read returns only the authenticated customer', async () => {
  const queries = [];
  const customer = {
    id: 7,
    first_name: 'Maria',
    last_name: 'Santos',
    full_name: 'Maria Santos',
    email: 'maria@example.test',
    phone: '+639171234567',
    avatar: null,
    created_at: new Date('2026-01-01T00:00:00Z'),
  };
  const testRouter = createAuthRouter(async (text, params) => {
    queries.push({ text, params });
    return { rows: [customer], rowCount: 1 };
  });
  const req = { userId: 7 };
  const res = responseRecorder();

  await authenticatedRouteHandler(testRouter, '/me', 'get')(req, res, (error) => { throw error; });

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.email, customer.email);
  assert.equal(queries.length, 1);
  assert.deepEqual(queries[0].params, [7]);
});

test('profile update scopes reads and writes to the authenticated customer', async () => {
  const queries = [];
  const current = {
    id: 9,
    first_name: 'Old',
    last_name: 'Name',
    full_name: 'Old Name',
    email: 'owner@example.test',
    phone: '+639171111111',
    avatar: null,
    created_at: new Date('2026-01-01T00:00:00Z'),
  };
  const testRouter = createAuthRouter(async (text, params) => {
    queries.push({ text, params });
    if (text.startsWith('SELECT * FROM users WHERE id')) return { rows: [current], rowCount: 1 };
    return {
      rows: [{
        ...current,
        first_name: params[1],
        last_name: params[2],
        full_name: params[3],
        phone: params[4],
        avatar: params[5],
      }],
      rowCount: 1,
    };
  });
  const req = {
    userId: 9,
    body: {
      firstName: 'New',
      lastName: 'Customer',
      phone: '0918 765 4321',
      avatar: 'data:image/jpeg;base64,cHJvZmlsZQ==',
    },
  };
  const res = responseRecorder();

  await authenticatedRouteHandler(testRouter, '/me', 'put')(req, res, (error) => { throw error; });

  assert.equal(res.body.fullName, 'New Customer');
  assert.equal(res.body.phone, '+639187654321');
  assert.equal(queries.length, 2);
  assert.deepEqual(queries[0].params, [9]);
  assert.equal(queries[1].params[0], 9);
});

test('profile update rejects invalid and unapproved fields before querying', async () => {
  let calls = 0;
  const testRouter = createAuthRouter(async () => {
    calls += 1;
    return { rows: [], rowCount: 0 };
  });
  const handler = authenticatedRouteHandler(testRouter, '/me', 'put');
  const unknownResponse = responseRecorder();
  await handler({ userId: 1, body: { email: 'changed@example.test' } }, unknownResponse, (error) => { throw error; });
  assert.equal(unknownResponse.statusCode, 400);
  assert.match(unknownResponse.body.message, /Unknown profile field/);

  const invalidResponse = responseRecorder();
  await handler({ userId: 1, body: { phone: '123' } }, invalidResponse, (error) => { throw error; });
  assert.equal(invalidResponse.statusCode, 400);
  assert.ok(invalidResponse.body.errors.phone);
  assert.equal(calls, 0);
});
