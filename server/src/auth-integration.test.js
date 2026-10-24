/**
 * @file auth-integration.test.js
 * @description Opt-in isolated PostgreSQL profile persistence and ownership tests.
 */
import test, { after, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import pg from 'pg';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const databaseUrl = process.env.DATABASE_URL;

if (!testDatabaseUrl) {
  test('real PostgreSQL profile integration', { skip: 'Set TEST_DATABASE_URL to an isolated loopback database.' }, () => {});
} else {
  const parsedUrl = new URL(testDatabaseUrl);
  if (!['localhost', '127.0.0.1', '[::1]'].includes(parsedUrl.hostname) || databaseUrl !== testDatabaseUrl) {
    throw new Error('Profile integration tests require matching database URLs on a loopback host.');
  }
  if (!/(?:test|sandbox)/i.test(parsedUrl.pathname.slice(1))) {
    throw new Error('Profile integration tests require an explicitly named local test or sandbox database.');
  }

  const { Pool } = pg;
  const adminUrl = new URL(testDatabaseUrl);
  adminUrl.pathname = '/postgres';
  adminUrl.search = '';
  const temporaryDatabaseName = `cookie_fluffs_profile_it_${process.pid}_${crypto.randomBytes(6).toString('hex')}`;
  const temporaryDatabaseUrl = new URL(testDatabaseUrl);
  temporaryDatabaseUrl.pathname = `/${temporaryDatabaseName}`;
  const quotedDatabase = `"${temporaryDatabaseName.replaceAll('"', '""')}"`;
  const adminPool = new Pool({ connectionString: adminUrl.toString(), ssl: false, max: 1 });
  let pool;
  let appPool;
  let router;
  let created = false;

  function handler(path, method) {
    const layer = router.stack.find((candidate) => candidate.route?.path === path && candidate.route.methods[method]);
    assert.ok(layer, `Expected ${method.toUpperCase()} ${path}`);
    return layer.route.stack.at(-1).handle;
  }

  function responseRecorder() {
    return {
      statusCode: 200,
      body: undefined,
      status(code) { this.statusCode = code; return this; },
      json(body) { this.body = body; return this; },
    };
  }

  before(async () => {
    const identity = await adminPool.query(
      'SELECT current_database() AS database, host(inet_server_addr()) AS address, inet_server_port() AS port',
    );
    assert.equal(identity.rows[0].database, 'postgres');
    assert.ok(['127.0.0.1', '::1'].includes(identity.rows[0].address));
    assert.equal(identity.rows[0].port, Number(parsedUrl.port || 5432));
    const existing = await adminPool.query('SELECT 1 FROM pg_database WHERE datname = $1', [temporaryDatabaseName]);
    assert.equal(existing.rowCount, 0, 'Refusing to reuse an existing database.');
    await adminPool.query(`CREATE DATABASE ${quotedDatabase} TEMPLATE template0`);
    created = true;

    process.env.DATABASE_URL = temporaryDatabaseUrl.toString();
    process.env.TEST_DATABASE_URL = temporaryDatabaseUrl.toString();
    const db = await import('./db.js');
    appPool = db.pool;
    await db.initDb();
    pool = new Pool({ connectionString: temporaryDatabaseUrl.toString(), ssl: false, max: 4 });
    const { createAuthRouter } = await import('./routes/auth.js');
    router = createAuthRouter((text, params) => pool.query(text, params));
  });

  after(async () => {
    if (pool) await pool.end();
    if (appPool) await appPool.end();
    if (created) {
      await adminPool.query(
        'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()',
        [temporaryDatabaseName],
      );
      await adminPool.query(`DROP DATABASE ${quotedDatabase}`);
    }
    await adminPool.end();
  });

  describe('real PostgreSQL profile persistence', { concurrency: false }, () => {
    test('reads and updates only the authenticated customer, including avatar persistence', async () => {
      const password = 'Profile1!Test';
      const passwordHash = await bcrypt.hash(password, 4);
      const first = await pool.query(
        `INSERT INTO users (full_name, first_name, last_name, email, phone, password_hash)
         VALUES ('First Customer', 'First', 'Customer', 'profile-first@example.test', '+639171111111', $1) RETURNING id`,
        [passwordHash],
      );
      const second = await pool.query(
        `INSERT INTO users (full_name, first_name, last_name, email, phone, password_hash)
         VALUES ('Second Customer', 'Second', 'Customer', 'profile-second@example.test', '+639172222222', 'test') RETURNING id`,
      );
      const userId = first.rows[0].id;
      const avatar = 'data:image/jpeg;base64,cHJvZmlsZQ==';
      const updateResponse = responseRecorder();
      await handler('/me', 'put')({
        userId,
        body: { firstName: 'Updated', lastName: 'Customer', phone: '0918 765 4321', avatar },
      }, updateResponse, (error) => { throw error; });
      assert.equal(updateResponse.statusCode, 200);
      assert.equal(updateResponse.body.fullName, 'Updated Customer');

      const persisted = await pool.query(
        'SELECT full_name, phone, avatar FROM users WHERE id = $1',
        [userId],
      );
      assert.deepEqual(persisted.rows[0], {
        full_name: 'Updated Customer', phone: '+639187654321', avatar,
      });
      const untouched = await pool.query('SELECT full_name, phone, avatar FROM users WHERE id = $1', [second.rows[0].id]);
      assert.deepEqual(untouched.rows[0], {
        full_name: 'Second Customer', phone: '+639172222222', avatar: null,
      });

      const readResponse = responseRecorder();
      await handler('/me', 'get')({ userId }, readResponse, (error) => { throw error; });
      assert.equal(readResponse.body.fullName, 'Updated Customer');
      assert.equal(readResponse.body.avatar, avatar);

      const loginResponse = responseRecorder();
      await handler('/login', 'post')(
        { body: { email: 'profile-first@example.test', password } },
        loginResponse,
        (error) => { throw error; },
      );
      assert.equal(loginResponse.statusCode, 200);
      assert.equal(loginResponse.body.user.fullName, 'Updated Customer');
      assert.equal(loginResponse.body.user.phone, '+639187654321');
      assert.equal(loginResponse.body.user.avatar, avatar);
    });

    test('rejects invalid and unapproved profile changes without persistence', async () => {
      const user = await pool.query(
        `INSERT INTO users (full_name, first_name, last_name, email, phone, password_hash)
         VALUES ('Safe Customer', 'Safe', 'Customer', 'profile-safe@example.test', '+639173333333', 'test') RETURNING id`,
      );
      const invalidResponse = responseRecorder();
      await handler('/me', 'put')(
        { userId: user.rows[0].id, body: { email: 'other@example.test' } },
        invalidResponse,
        (error) => { throw error; },
      );
      assert.equal(invalidResponse.statusCode, 400);
      const persisted = await pool.query('SELECT email FROM users WHERE id = $1', [user.rows[0].id]);
      assert.equal(persisted.rows[0].email, 'profile-safe@example.test');
    });
  });
}
