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
  let recovery;
  let recoveryNow;
  let deliveredEmails;
  let failDelivery;
  let googleAuth;
  let googlePayload;
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
    const { changeCustomerPassword } = await import('./account-security-service.js');
    const { createPasswordRecoveryService } = await import('./password-recovery-service.js');
    const { createGoogleAuthService } = await import('./google-auth-service.js');
    recoveryNow = new Date('2026-10-25T00:00:00.000Z');
    deliveredEmails = [];
    failDelivery = false;
    recovery = createPasswordRecoveryService({
      databasePool: pool,
      config: {
        enabled: true,
        origin: 'https://cookies.example.test',
        tokenPepper: 'integration-recovery-pepper-with-unique-characters-2947',
        brevoApiKey: 'unused',
        senderEmail: 'sender@example.test',
        senderName: 'Cookie Fluffs',
      },
      emailAdapter: {
        sendPasswordReset: async (message) => {
          if (failDelivery) throw new Error('simulated delivery failure');
          deliveredEmails.push(message);
        },
      },
      now: () => new Date(recoveryNow),
    });
    googleAuth = createGoogleAuthService({
      databasePool: pool,
      config: {
        enabled: true,
        webClientId: '123456789-cookie-fluffs.apps.googleusercontent.com',
        noncePepper: 'integration-google-pepper-with-unique-characters-2947',
      },
      oauthClient: {
        verifyIdToken: async () => ({ getPayload: () => googlePayload }),
      },
    });
    router = createAuthRouter((text, params) => pool.query(text, params), {
      authenticate: (req, _res, next) => next(),
      changePassword: (userId, currentPassword, newPassword) => changeCustomerPassword(
        userId,
        currentPassword,
        newPassword,
        { databasePool: pool },
      ),
      recovery,
      googleAuth,
    });
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
        body: { firstName: 'Updated', lastName: 'Customer', avatar },
      }, updateResponse, (error) => { throw error; });
      assert.equal(updateResponse.statusCode, 200);
      assert.equal(updateResponse.body.fullName, 'Updated Customer');

      const persisted = await pool.query(
        'SELECT full_name, phone, avatar FROM users WHERE id = $1',
        [userId],
      );
      // Phone is preserved unchanged (no longer editable via PUT /me; use verified Change Phone).
      assert.deepEqual(persisted.rows[0], {
        full_name: 'Updated Customer', phone: '+639171111111', avatar,
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
      assert.equal(loginResponse.body.user.phone, '+639171111111');
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

    test('changes a password once, revokes the old token, and accepts the replacement', async () => {
      const oldPassword = 'Original1!Pass';
      const newPassword = 'Fresh2!Cookie';
      const inserted = await pool.query(
        `INSERT INTO users (full_name, first_name, last_name, email, phone, password_hash)
         VALUES ('Secure Customer', 'Secure', 'Customer', 'security@example.test', '+639174444444', $1)
         RETURNING *`,
        [await bcrypt.hash(oldPassword, 4)],
      );
      const user = inserted.rows[0];
      const { createRequireAuth, signToken } = await import('./auth.js');
      const oldToken = signToken(user);
      const response = responseRecorder();
      await handler('/change-password', 'post')(
        { userId: user.id, body: { currentPassword: oldPassword, newPassword } },
        response,
        (error) => { throw error; },
      );
      assert.equal(response.statusCode, 200);
      assert.equal(typeof response.body.token, 'string');

      const persisted = await pool.query(
        'SELECT auth_version, password_changed_at, password_hash FROM users WHERE id = $1',
        [user.id],
      );
      assert.equal(persisted.rows[0].auth_version, 2);
      assert.ok(persisted.rows[0].password_changed_at);
      assert.equal(await bcrypt.compare(newPassword, persisted.rows[0].password_hash), true);

      const authenticate = createRequireAuth((text, params) => pool.query(text, params));
      const oldResponse = responseRecorder();
      await authenticate(
        { headers: { authorization: `Bearer ${oldToken}` } },
        oldResponse,
        () => assert.fail('Old token must not continue.'),
      );
      assert.equal(oldResponse.statusCode, 401);
      let replacementAccepted = false;
      await authenticate(
        { headers: { authorization: `Bearer ${response.body.token}` } },
        responseRecorder(),
        () => { replacementAccepted = true; },
      );
      assert.equal(replacementAccepted, true);

      const { changeCustomerPassword } = await import('./account-security-service.js');
      const reused = await changeCustomerPassword(user.id, newPassword, newPassword, { databasePool: pool });
      assert.equal(reused.kind, 'reused');
      const weak = await changeCustomerPassword(user.id, newPassword, 'weak', { databasePool: pool });
      assert.equal(weak.kind, 'invalid_new');
      const unchangedVersion = await pool.query('SELECT auth_version FROM users WHERE id = $1', [user.id]);
      assert.equal(unchangedVersion.rows[0].auth_version, 2);
    });

    test('serializes concurrent password changes and enforces durable failed-attempt throttling', async () => {
      const password = 'Original1!Lock';
      const inserted = await pool.query(
        `INSERT INTO users (full_name, first_name, last_name, email, phone, password_hash)
         VALUES ('Locked Customer', 'Locked', 'Customer', 'locked@example.test', '+639175555555', $1)
         RETURNING id`,
        [await bcrypt.hash(password, 4)],
      );
      const userId = inserted.rows[0].id;
      const { changeCustomerPassword } = await import('./account-security-service.js');
      const results = await Promise.all([
        changeCustomerPassword(userId, password, 'First2!Replacement', { databasePool: pool }),
        changeCustomerPassword(userId, password, 'Second3!Replacement', { databasePool: pool }),
      ]);
      assert.equal(results.filter((result) => result.kind === 'changed').length, 1);
      const version = await pool.query('SELECT auth_version FROM users WHERE id = $1', [userId]);
      assert.equal(version.rows[0].auth_version, 2);

      for (let attempt = 0; attempt < 4; attempt += 1) {
        const result = await changeCustomerPassword(userId, 'Incorrect1!', 'Another4!Replacement', { databasePool: pool });
        assert.equal(result.kind, 'invalid_current');
      }
      const throttled = await changeCustomerPassword(
        userId,
        'Incorrect1!',
        'Another4!Replacement',
        { databasePool: pool },
      );
      assert.equal(throttled.kind, 'throttled');
      assert.ok(throttled.retryAfter >= 1 && throttled.retryAfter <= 900);
      const failures = await pool.query(
        `SELECT count(*)::int AS count FROM auth_rate_limits
         WHERE user_id = $1 AND action = 'change_password'`,
        [userId],
      );
      assert.equal(failures.rows[0].count, 5);

      const expiryUser = await pool.query(
        `INSERT INTO users (full_name, first_name, last_name, email, phone, password_hash)
         VALUES ('Expiry Customer', 'Expiry', 'Customer', 'expiry@example.test', '+639176666666', $1)
         RETURNING id`,
        [await bcrypt.hash(password, 4)],
      );
      const oldNow = new Date(Date.now() - 16 * 60_000);
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const failed = await changeCustomerPassword(
          expiryUser.rows[0].id,
          'Incorrect1!',
          'Another4!Replacement',
          { databasePool: pool, now: oldNow },
        );
        assert.equal(failed.kind, 'invalid_current');
      }
      const afterExpiry = await changeCustomerPassword(
        expiryUser.rows[0].id,
        'Incorrect1!',
        'Another4!Replacement',
        { databasePool: pool },
      );
      assert.equal(afterExpiry.kind, 'invalid_current');
    });

    test('resets a password once, revokes sessions, and stores only a keyed token hash', async () => {
      const oldPassword = 'Original1!Recovery';
      const newPassword = 'Fresh2!Cookie';
      const inserted = await pool.query(
        `INSERT INTO users (full_name, first_name, last_name, email, phone, password_hash)
         VALUES ('Recovery Customer', 'Recovery', 'Customer', 'recovery@example.test', '+639177777777', $1)
         RETURNING *`,
        [await bcrypt.hash(oldPassword, 4)],
      );
      const user = inserted.rows[0];
      const { createRequireAuth, signToken } = await import('./auth.js');
      const oldToken = signToken(user);
      const request = await recovery.requestReset(user.email, '127.0.0.71');
      assert.equal(request.kind, 'accepted');
      assert.ok(request.delivery);
      const url = new URL(request.delivery.url);
      const selector = url.searchParams.get('selector');
      const token = url.hash.slice('#token='.length);
      const stored = await pool.query(
        'SELECT token_hash, delivery_status FROM password_reset_tokens WHERE selector = $1',
        [selector],
      );
      assert.notEqual(stored.rows[0].token_hash, token);
      assert.equal(stored.rows[0].token_hash.length, 64);
      assert.equal(stored.rows[0].delivery_status, 'pending');
      await recovery.deliverReset(request.delivery);
      assert.equal(deliveredEmails.length, 1);

      const [first, replay] = await Promise.all([
        recovery.resetPassword(selector, token, newPassword),
        recovery.resetPassword(selector, token, newPassword),
      ]);
      assert.deepEqual(new Set([first.kind, replay.kind]), new Set(['changed', 'invalid']));
      const persisted = await pool.query(
        'SELECT auth_version, password_changed_at, password_hash FROM users WHERE id = $1',
        [user.id],
      );
      assert.equal(persisted.rows[0].auth_version, 2);
      assert.ok(persisted.rows[0].password_changed_at);
      assert.equal(await bcrypt.compare(newPassword, persisted.rows[0].password_hash), true);
      assert.equal((await recovery.resetPassword(selector, token, newPassword)).kind, 'invalid');

      const authenticate = createRequireAuth((text, params) => pool.query(text, params));
      const oldResponse = responseRecorder();
      await authenticate(
        { headers: { authorization: `Bearer ${oldToken}` } },
        oldResponse,
        () => assert.fail('Reset must revoke previous sessions.'),
      );
      assert.equal(oldResponse.statusCode, 401);
    });

    test('enforces request, expiry, verification-attempt, and delivery-failure controls', async () => {
      const inserted = await pool.query(
        `INSERT INTO users (full_name, first_name, last_name, email, phone, password_hash)
         VALUES ('Recovery Limits', 'Recovery', 'Limits', 'recovery-limits@example.test', '+639178888888', $1)
         RETURNING id, email`,
        [await bcrypt.hash('Original1!Limits', 4)],
      );
      const user = inserted.rows[0];
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const accepted = await recovery.requestReset(user.email, `127.0.0.${80 + attempt}`);
        assert.equal(accepted.throttled, undefined);
      }
      const throttled = await recovery.requestReset(user.email, '127.0.0.90');
      assert.equal(throttled.throttled, true);
      for (let attempt = 0; attempt < 10; attempt += 1) {
        const accepted = await recovery.requestReset(`unknown-${attempt}@example.test`, '127.0.0.94');
        assert.equal(accepted.throttled, undefined);
        assert.equal(accepted.delivery, null);
      }
      const ipThrottled = await recovery.requestReset('unknown-final@example.test', '127.0.0.94');
      assert.equal(ipThrottled.throttled, true);
      const concurrentIpResults = await Promise.all(Array.from({ length: 11 }, (_, attempt) => (
        recovery.requestReset(`concurrent-${attempt}@example.test`, '127.0.0.95')
      )));
      assert.equal(concurrentIpResults.filter((result) => result.throttled).length, 1);

      const expiryUser = await pool.query(
        `INSERT INTO users (full_name, first_name, last_name, email, phone, password_hash)
         VALUES ('Recovery Expiry', 'Recovery', 'Expiry', 'recovery-expiry@example.test', '+639179999999', $1)
         RETURNING email`,
        [await bcrypt.hash('Original1!Expiry', 4)],
      );
      const expiring = await recovery.requestReset(expiryUser.rows[0].email, '127.0.0.91');
      const expiringUrl = new URL(expiring.delivery.url);
      recoveryNow = new Date(recoveryNow.getTime() + 31 * 60_000);
      assert.equal((await recovery.resetPassword(
        expiringUrl.searchParams.get('selector'),
        expiringUrl.hash.slice('#token='.length),
        'Fresh2!Cookie',
      )).kind, 'invalid');

      const attemptsUser = await pool.query(
        `INSERT INTO users (full_name, first_name, last_name, email, phone, password_hash)
         VALUES ('Recovery Attempts', 'Recovery', 'Attempts', 'recovery-attempts@example.test', '+639171010101', $1)
         RETURNING email`,
        [await bcrypt.hash('Original1!Attempts', 4)],
      );
      const limited = await recovery.requestReset(attemptsUser.rows[0].email, '127.0.0.92');
      const limitedUrl = new URL(limited.delivery.url);
      for (let attempt = 0; attempt < 5; attempt += 1) {
        assert.equal((await recovery.resetPassword(
          limitedUrl.searchParams.get('selector'),
          'z'.repeat(43),
          'Fresh2!Cookie',
        )).kind, 'invalid');
      }
      assert.equal((await recovery.resetPassword(
        limitedUrl.searchParams.get('selector'),
        limitedUrl.hash.slice('#token='.length),
        'Fresh2!Cookie',
      )).kind, 'invalid');

      failDelivery = true;
      const failedDelivery = await recovery.requestReset(attemptsUser.rows[0].email, '127.0.0.93');
      await recovery.deliverReset(failedDelivery.delivery);
      const deliveryState = await pool.query(
        'SELECT delivery_status FROM password_reset_tokens WHERE selector = $1',
        [new URL(failedDelivery.delivery.url).searchParams.get('selector')],
      );
      assert.equal(deliveryState.rows[0].delivery_status, 'failed');
      const privacy = await pool.query(
        `SELECT count(*)::int AS count FROM auth_recovery_rate_limits
         WHERE identifier_hash LIKE '%@%' OR identifier_hash LIKE '127.%'`,
      );
      assert.equal(privacy.rows[0].count, 0);
    });

    test('links by verified Google subject only after password confirmation and blocks nonce replay', async () => {
      const password = 'Existing1!Cookie';
      const inserted = await pool.query(
        `INSERT INTO users (full_name, first_name, last_name, email, phone, password_hash)
         VALUES ('Google Link', 'Google', 'Link', 'google-link@example.test', '+639171212121', $1)
         RETURNING id`,
        [await bcrypt.hash(password, 4)],
      );
      const nonce = await googleAuth.issueNonce({ intent: 'login' });
      googlePayload = {
        iss: 'https://accounts.google.com',
        aud: '123456789-cookie-fluffs.apps.googleusercontent.com',
        sub: 'google-subject-link-1',
        email: 'google-link@example.test',
        email_verified: true,
        given_name: 'Google',
        family_name: 'Link',
        nonce: nonce.nonce,
        exp: Math.floor(Date.now() / 1000) + 600,
      };
      const pending = await googleAuth.authenticate({
        selector: nonce.selector,
        nonce: nonce.nonce,
        idToken: 'verified-google-id-token'.padEnd(120, 'x'),
      });
      assert.equal(pending.kind, 'link_required');
      assert.equal((await googleAuth.authenticate({
        selector: nonce.selector,
        nonce: nonce.nonce,
        idToken: 'verified-google-id-token'.padEnd(120, 'x'),
      })).kind, 'invalid');

      const rejected = await googleAuth.linkAccount({
        selector: pending.selector, challenge: pending.challenge, password: 'Wrong1!Cookie',
      });
      assert.equal(rejected.kind, 'restart_required');
      assert.equal(rejected.code, 'google_link_restart_required');
      assert.equal((await googleAuth.linkAccount({
        selector: pending.selector, challenge: pending.challenge, password,
      })).kind, 'restart_required');

      const freshNonce = await googleAuth.issueNonce({ intent: 'login' });
      googlePayload.nonce = freshNonce.nonce;
      const freshPending = await googleAuth.authenticate({
        selector: freshNonce.selector,
        nonce: freshNonce.nonce,
        idToken: 'verified-google-id-token'.padEnd(120, 'x'),
      });
      assert.equal(freshPending.kind, 'link_required');
      const linked = await googleAuth.linkAccount({
        selector: freshPending.selector, challenge: freshPending.challenge, password,
      });
      assert.equal(linked.kind, 'authenticated');
      assert.equal(linked.user.id, inserted.rows[0].id);
      assert.equal((await pool.query(
        'SELECT count(*)::int AS count FROM user_google_identities WHERE user_id = $1',
        [inserted.rows[0].id],
      )).rows[0].count, 1);

      const loginNonce = await googleAuth.issueNonce({ intent: 'login' });
      googlePayload.nonce = loginNonce.nonce;
      assert.equal((await googleAuth.authenticate({
        selector: loginNonce.selector,
        nonce: loginNonce.nonce,
        idToken: 'verified-google-id-token'.padEnd(120, 'x'),
      })).kind, 'authenticated');
      assert.equal((await pool.query(
        'SELECT count(*)::int AS count FROM user_google_identities WHERE user_id = $1',
        [inserted.rows[0].id],
      )).rows[0].count, 1);
    });

    test('creates a Google-only account with a reviewed name, required phone and no password fallback', async () => {
      const nonce = await googleAuth.issueNonce({ intent: 'signup' });
      googlePayload = {
        iss: 'accounts.google.com',
        aud: '123456789-cookie-fluffs.apps.googleusercontent.com',
        sub: 'google-subject-signup-1',
        email: 'google-signup@example.test',
        email_verified: true,
        given_name: 'New',
        family_name: 'Customer',
        nonce: nonce.nonce,
        exp: Math.floor(Date.now() / 1000) + 600,
      };
      const pending = await googleAuth.authenticate({
        selector: nonce.selector,
        nonce: nonce.nonce,
        idToken: 'verified-google-id-token'.padEnd(120, 'x'),
      });
      assert.equal(pending.kind, 'signup_required');
      // Invalid phone is rejected.
      assert.equal((await googleAuth.completeSignup({
        selector: pending.selector, challenge: pending.challenge,
        firstName: 'New', lastName: 'Customer', phone: '123', acceptedTerms: true,
      })).kind, 'invalid');
      // Invalid reviewed name is rejected without creating an account.
      assert.equal((await googleAuth.completeSignup({
        selector: pending.selector, challenge: pending.challenge,
        firstName: 'A', lastName: 'Customer', phone: '0917 343 4343', acceptedTerms: true,
      })).kind, 'invalid');
      // Missing consent is rejected.
      assert.equal((await googleAuth.completeSignup({
        selector: pending.selector, challenge: pending.challenge,
        firstName: 'New', lastName: 'Customer', phone: '0917 343 4343', acceptedTerms: false,
      })).kind, 'invalid');
      const completed = await googleAuth.completeSignup({
        selector: pending.selector,
        challenge: pending.challenge,
        firstName: 'Reviewed',
        lastName: 'Customer',
        phone: '0917 343 4343',
        acceptedTerms: true,
      });
      assert.equal(completed.kind, 'authenticated');
      assert.equal(completed.user.password_hash, null);
      assert.equal(completed.user.full_name, 'Reviewed Customer');
      // The consumed challenge cannot be replayed.
      assert.equal((await googleAuth.completeSignup({
        selector: pending.selector,
        challenge: pending.challenge,
        firstName: 'Reviewed',
        lastName: 'Customer',
        phone: '0917 343 4343',
        acceptedTerms: true,
      })).kind, 'invalid');

      const loginResponse = responseRecorder();
      await handler('/login', 'post')(
        { body: { email: 'google-signup@example.test', password: 'Any1!Password' } },
        loginResponse,
        (error) => { throw error; },
      );
      assert.equal(loginResponse.statusCode, 401);
    });

    test('blocks an unregistered Google account chosen on Login and creates no customer', async () => {
      const before = await pool.query('SELECT count(*)::int AS count FROM users');
      const nonce = await googleAuth.issueNonce({ intent: 'login' });
      googlePayload = {
        iss: 'accounts.google.com',
        aud: '123456789-cookie-fluffs.apps.googleusercontent.com',
        sub: 'google-subject-login-unregistered',
        email: 'login-unregistered@example.test',
        email_verified: true,
        given_name: 'Visitor',
        family_name: 'Example',
        nonce: nonce.nonce,
        exp: Math.floor(Date.now() / 1000) + 600,
      };
      const result = await googleAuth.authenticate({
        selector: nonce.selector,
        nonce: nonce.nonce,
        idToken: 'verified-google-id-token'.padEnd(120, 'x'),
      });
      assert.equal(result.kind, 'signup_needed');
      assert.equal('user' in result, false);
      const after = await pool.query('SELECT count(*)::int AS count FROM users');
      assert.equal(after.rows[0].count, before.rows[0].count);
      const created = await pool.query('SELECT 1 FROM users WHERE email = $1', ['login-unregistered@example.test']);
      assert.equal(created.rowCount, 0);
      // The consumed nonce cannot be replayed to flip intent into a signup.
      const replay = await googleAuth.authenticate({
        selector: nonce.selector,
        nonce: nonce.nonce,
        idToken: 'verified-google-id-token'.padEnd(120, 'x'),
      });
      assert.equal(replay.kind, 'invalid');
    });

    test('guides an already-linked identity chosen on Sign Up to log in instead', async () => {
      const inserted = await pool.query(
        `INSERT INTO users (full_name, first_name, last_name, email, phone, password_hash)
         VALUES ('Linked Signup', 'Linked', 'Signup', 'linked-signup@example.test', '+639171313131', NULL)
         RETURNING id`,
      );
      await pool.query(
        'INSERT INTO user_google_identities (user_id, google_subject) VALUES ($1, $2)',
        [inserted.rows[0].id, 'google-subject-linked-signup'],
      );
      const nonce = await googleAuth.issueNonce({ intent: 'signup' });
      googlePayload = {
        iss: 'accounts.google.com',
        aud: '123456789-cookie-fluffs.apps.googleusercontent.com',
        sub: 'google-subject-linked-signup',
        email: 'linked-signup@example.test',
        email_verified: true,
        given_name: 'Linked',
        family_name: 'Signup',
        nonce: nonce.nonce,
        exp: Math.floor(Date.now() / 1000) + 600,
      };
      const result = await googleAuth.authenticate({
        selector: nonce.selector,
        nonce: nonce.nonce,
        idToken: 'verified-google-id-token'.padEnd(120, 'x'),
      });
      assert.equal(result.kind, 'login_required');
      assert.equal('user' in result, false);
    });

    test('rejects a missing or unknown nonce intent without issuing a nonce', async () => {
      assert.equal((await googleAuth.issueNonce()).kind, 'invalid');
      assert.equal((await googleAuth.issueNonce({ intent: 'bogus' })).kind, 'invalid');
      const issued = await pool.query(
        `SELECT count(*)::int AS count FROM google_auth_nonces WHERE intent IS NULL`,
      );
      assert.equal(issued.rows[0].count, 0);
    });

    test('persists, then clears, optional gender and date of birth', async () => {
      const inserted = await pool.query(
        `INSERT INTO users (full_name, first_name, last_name, email, phone, password_hash)
         VALUES ('Profile Optional', 'Profile', 'Optional', 'profile-optional@example.test', '+639173434343', 'test')
         RETURNING id`,
      );
      const userId = inserted.rows[0].id;

      const setRes = responseRecorder();
      await handler('/me', 'put')(
        { userId, body: { gender: 'female', dateOfBirth: '1995-03-15' } },
        setRes, (error) => { throw error; },
      );
      assert.equal(setRes.statusCode, 200);
      assert.equal(setRes.body.gender, 'female');
      assert.equal(setRes.body.dateOfBirth, '1995-03-15');
      const storedSet = await pool.query('SELECT gender, date_of_birth FROM users WHERE id = $1', [userId]);
      assert.equal(storedSet.rows[0].gender, 'female');

      // Explicit null clears both optional fields.
      const clearRes = responseRecorder();
      await handler('/me', 'put')(
        { userId, body: { gender: null, dateOfBirth: null } },
        clearRes, (error) => { throw error; },
      );
      assert.equal(clearRes.statusCode, 200);
      assert.equal(clearRes.body.gender, null);
      assert.equal(clearRes.body.dateOfBirth, null);
      const storedClear = await pool.query('SELECT gender, date_of_birth FROM users WHERE id = $1', [userId]);
      assert.equal(storedClear.rows[0].gender, null);
      assert.equal(storedClear.rows[0].date_of_birth, null);

      // The database rejects out-of-range values defensively (future DOB, bad gender).
      await assert.rejects(() => pool.query(
        'UPDATE users SET date_of_birth = $2 WHERE id = $1',
        [userId, '2999-01-01'],
      ));
      await assert.rejects(() => pool.query(
        'UPDATE users SET gender = $2 WHERE id = $1',
        [userId, 'other'],
      ));
    });
  });
}
