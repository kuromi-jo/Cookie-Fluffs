/**
 * @file auth.test.js
 * @description Route-level checks for signup enforcement and legacy login compatibility.
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import pg from 'pg';

process.env.DATABASE_URL = 'postgresql://test:test@localhost/test';
process.env.JWT_SECRET = 'test-only-cookie-fluffs-secret';

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

const { default: router } = await import('./auth.js');
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
