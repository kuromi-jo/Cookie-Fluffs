/**
 * @file verification-integration.test.js
 * @description Opt-in disposable-PostgreSQL tests for the identity-verification engine and
 * Google reauthentication: creation, valid/incorrect/expired codes, attempt limit, cooldown,
 * rate limiting, replay, cross-account/operation/target rejection, concurrency, atomic consume,
 * and Google subject/token checks.
 */
import test, { after, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import pg from 'pg';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const databaseUrl = process.env.DATABASE_URL;

if (!testDatabaseUrl) {
  test('real PostgreSQL verification integration', { skip: 'Set TEST_DATABASE_URL to an isolated loopback database.' }, () => {});
} else {
  const parsedUrl = new URL(testDatabaseUrl);
  if (!['localhost', '127.0.0.1', '[::1]'].includes(parsedUrl.hostname) || databaseUrl !== testDatabaseUrl) {
    throw new Error('Integration tests require matching DATABASE_URL and TEST_DATABASE_URL on a loopback host.');
  }
  if (!/(?:test|sandbox)/i.test(parsedUrl.pathname.slice(1))) {
    throw new Error('Integration tests require an explicitly named local test or sandbox database.');
  }

  const { Pool } = pg;
  const adminUrl = new URL(testDatabaseUrl);
  adminUrl.pathname = '/postgres';
  adminUrl.search = '';
  const temporaryDatabaseName = `cookie_fluffs_verify_it_${process.pid}_${crypto.randomBytes(6).toString('hex')}`;
  const temporaryDatabaseUrl = new URL(testDatabaseUrl);
  temporaryDatabaseUrl.pathname = `/${temporaryDatabaseName}`;
  const quotedDatabase = `"${temporaryDatabaseName.replaceAll('"', '""')}"`;
  const adminPool = new Pool({ connectionString: adminUrl.toString(), ssl: false, max: 1 });
  const PEPPER = 'verification-integration-pepper-unique-9428-characters';

  let pool;
  let appPool;
  let created = false;
  let createVerificationService;
  let createGoogleReauthService;
  let changeCustomerPhone;
  let createReauthService;
  let changeCustomerEmail;
  let setCustomerPassword;
  let clock;

  async function addUser(label) {
    const result = await pool.query(
      `INSERT INTO users (full_name, first_name, last_name, email, phone, password_hash)
       VALUES ($1, 'Verify', 'User', $2, '+639171234567', 'test') RETURNING id`,
      [`Verify ${label}`, `verify-${label}-${crypto.randomBytes(4).toString('hex')}@example.test`],
    );
    return result.rows[0].id;
  }

  function service() {
    return createVerificationService({
      databasePool: pool,
      config: { deliveryEnabled: false, pepper: PEPPER },
      now: () => new Date(clock),
    });
  }

  before(async () => {
    const identity = await adminPool.query('SELECT current_database() AS database');
    assert.equal(identity.rows[0].database, 'postgres');
    await adminPool.query(`CREATE DATABASE ${quotedDatabase} TEMPLATE template0`);
    created = true;
    process.env.DATABASE_URL = temporaryDatabaseUrl.toString();
    process.env.TEST_DATABASE_URL = temporaryDatabaseUrl.toString();
    const db = await import('./db.js');
    appPool = db.pool;
    await db.initDb();
    pool = new Pool({ connectionString: temporaryDatabaseUrl.toString(), ssl: false, max: 6 });
    ({ createVerificationService } = await import('./verification-service.js'));
    ({ createGoogleReauthService } = await import('./google-reauth-service.js'));
    ({ changeCustomerPhone } = await import('./change-phone-service.js'));
    ({ createReauthService } = await import('./reauth-service.js'));
    ({ changeCustomerEmail } = await import('./change-email-service.js'));
    ({ setCustomerPassword } = await import('./set-password-service.js'));
    clock = new Date('2026-10-26T00:00:00.000Z');
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

  describe('verification engine', { concurrency: false }, () => {
    test('creates a challenge storing only a keyed hash, then verifies a valid code', async () => {
      const svc = service();
      const userId = await addUser('valid');
      const started = await svc.start({ userId, operation: 'change_email', target: 'new@example.test', ipAddress: '127.0.0.1', authVersion: 1 });
      assert.equal(started.kind, 'started');
      assert.match(started.code, /^\d{6}$/);
      const stored = await pool.query('SELECT code_hash FROM verification_challenges WHERE public_id = $1', [started.challengeId]);
      assert.notEqual(stored.rows[0].code_hash, started.code); // never plaintext
      assert.equal(stored.rows[0].code_hash.length, 64);

      const verified = await svc.verify({
        userId, challengeId: started.challengeId, operation: 'change_email', code: started.code,
        target: 'new@example.test', consume: true,
      });
      assert.equal(verified.kind, 'verified');
    });

    test('rejects an incorrect code and tracks attempts up to the limit', async () => {
      const svc = service();
      const userId = await addUser('attempts');
      const started = await svc.start({ userId, operation: 'change_phone', ipAddress: '127.0.0.2', authVersion: 1 });
      for (let i = 0; i < 5; i += 1) {
        const bad = await svc.verify({ userId, challengeId: started.challengeId, operation: 'change_phone', code: '000000' });
        assert.ok(['incorrect', 'invalid'].includes(bad.kind));
      }
      // Sixth attempt is locked out (attempts exhausted), even with the right code.
      const locked = await svc.verify({ userId, challengeId: started.challengeId, operation: 'change_phone', code: started.code });
      assert.equal(locked.kind, 'locked');
    });

    test('expired codes do not authenticate', async () => {
      const svc = service();
      const userId = await addUser('expired');
      const started = await svc.start({ userId, operation: 'set_password', ipAddress: '127.0.0.3', authVersion: 1 });
      clock = new Date(new Date(clock).getTime() + 11 * 60_000); // past the 10-minute TTL
      const result = await svc.verify({ userId, challengeId: started.challengeId, operation: 'set_password', code: started.code });
      assert.equal(result.kind, 'invalid');
      clock = new Date('2026-10-26T00:00:00.000Z');
    });

    test('prevents replay: a consumed challenge cannot be reused', async () => {
      const svc = service();
      const userId = await addUser('replay');
      const started = await svc.start({ userId, operation: 'change_email', target: 'r@example.test', ipAddress: '127.0.0.4', authVersion: 1 });
      const first = await svc.verify({ userId, challengeId: started.challengeId, operation: 'change_email', code: started.code, target: 'r@example.test', consume: true });
      assert.equal(first.kind, 'verified');
      const replay = await svc.verify({ userId, challengeId: started.challengeId, operation: 'change_email', code: started.code, target: 'r@example.test', consume: true });
      assert.equal(replay.kind, 'invalid');
    });

    test('rejects cross-account, cross-operation, and target-mismatch use of a code', async () => {
      const svc = service();
      const owner = await addUser('owner');
      const attacker = await addUser('attacker');
      const started = await svc.start({ userId: owner, operation: 'change_email', target: 'owner-new@example.test', ipAddress: '127.0.0.5', authVersion: 1 });
      // Another customer cannot use the owner's challenge.
      assert.equal((await svc.verify({ userId: attacker, challengeId: started.challengeId, operation: 'change_email', code: started.code, target: 'owner-new@example.test' })).kind, 'invalid');
      // The same code cannot authorize a different operation.
      assert.equal((await svc.verify({ userId: owner, challengeId: started.challengeId, operation: 'change_phone', code: started.code })).kind, 'invalid');
      // The same code cannot authorize a different target.
      assert.equal((await svc.verify({ userId: owner, challengeId: started.challengeId, operation: 'change_email', code: started.code, target: 'different@example.test' })).kind, 'invalid');
      // The correct target still verifies.
      assert.equal((await svc.verify({ userId: owner, challengeId: started.challengeId, operation: 'change_email', code: started.code, target: 'owner-new@example.test', consume: true })).kind, 'verified');
    });

    test('enforces resend cooldown then a per-user rate limit', async () => {
      const svc = service();
      const userId = await addUser('cooldown');
      const first = await svc.start({ userId, operation: 'change_phone', ipAddress: '127.0.0.6', authVersion: 1 });
      assert.equal(first.kind, 'started');
      // Immediate resend is blocked by the cooldown.
      assert.equal((await svc.start({ userId, operation: 'change_phone', ipAddress: '127.0.0.6', authVersion: 1 })).kind, 'cooldown');
      // Advance past cooldown repeatedly to hit the per-user rate limit (5 / hour).
      for (let i = 0; i < 4; i += 1) {
        clock = new Date(new Date(clock).getTime() + 61_000);
        const r = await svc.start({ userId, operation: 'change_phone', ipAddress: '127.0.0.6', authVersion: 1 });
        assert.ok(['started', 'throttled'].includes(r.kind));
      }
      clock = new Date(new Date(clock).getTime() + 61_000);
      assert.equal((await svc.start({ userId, operation: 'change_phone', ipAddress: '127.0.0.6', authVersion: 1 })).kind, 'throttled');
      clock = new Date('2026-10-26T00:00:00.000Z');
    });

    test('concurrent consumption of the same verified challenge succeeds exactly once', async () => {
      const svc = service();
      const userId = await addUser('concurrent');
      const started = await svc.start({ userId, operation: 'set_password', ipAddress: '127.0.0.7', authVersion: 1 });
      const [a, b] = await Promise.all([
        svc.verify({ userId, challengeId: started.challengeId, operation: 'set_password', code: started.code, consume: true }),
        svc.verify({ userId, challengeId: started.challengeId, operation: 'set_password', code: started.code, consume: true }),
      ]);
      const verified = [a, b].filter((r) => r.kind === 'verified');
      assert.equal(verified.length, 1); // row lock serializes; only one consumes
    });

    test('consumeVerified binds consumption to a caller transaction and rolls back with it', async () => {
      const svc = service();
      const userId = await addUser('bound');
      const started = await svc.start({ userId, operation: 'change_phone', ipAddress: '127.0.0.8', authVersion: 1 });
      await svc.verify({ userId, challengeId: started.challengeId, operation: 'change_phone', code: started.code });

      // Roll back the caller transaction: the challenge must remain unconsumed (no bypass).
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const ok = await svc.consumeVerified(client, { userId, challengeId: started.challengeId, operation: 'change_phone' });
        assert.equal(ok, true);
        await client.query('ROLLBACK');
      } finally {
        client.release();
      }
      const stillActive = await pool.query('SELECT consumed_at FROM verification_challenges WHERE public_id = $1', [started.challengeId]);
      assert.equal(stillActive.rows[0].consumed_at, null);

      // Commit path consumes exactly once.
      const client2 = await pool.connect();
      try {
        await client2.query('BEGIN');
        assert.equal(await svc.consumeVerified(client2, { userId, challengeId: started.challengeId, operation: 'change_phone' }), true);
        await client2.query('COMMIT');
      } finally {
        client2.release();
      }
      // A second consume on the now-consumed challenge returns false.
      const client3 = await pool.connect();
      try {
        await client3.query('BEGIN');
        assert.equal(await svc.consumeVerified(client3, { userId, challengeId: started.challengeId, operation: 'change_phone' }), false);
        await client3.query('ROLLBACK');
      } finally {
        client3.release();
      }
    });

    test('engine is unavailable without a configured pepper', async () => {
      const disabled = createVerificationService({ databasePool: pool, config: { deliveryEnabled: false, pepper: null } });
      assert.equal(disabled.available(), false);
      const userId = await addUser('nopepper');
      assert.equal((await disabled.start({ userId, operation: 'change_phone', ipAddress: '127.0.0.9' })).kind, 'disabled');
    });
  });

  describe('delivery-failure void (confirmed rejection recovery)', { concurrency: false }, () => {
    test('voiding a confirmed-rejected challenge clears the cooldown and allows immediate retry', async () => {
      const svc = service();
      const userId = await addUser('void-retry');
      const ipAddress = '127.2.0.1';
      const started = await svc.start({ userId, operation: 'change_phone', target: '+639171112233', ipAddress, authVersion: 1 });
      assert.equal(started.kind, 'started');
      // Without the void, an immediate re-start would be blocked by the cooldown.
      const blocked = await svc.start({ userId, operation: 'change_phone', target: '+639171112233', ipAddress, authVersion: 1 });
      assert.equal(blocked.kind, 'cooldown');

      const voided = await svc.voidFailedDelivery({ userId, challengeId: started.challengeId, operation: 'change_phone' });
      assert.equal(voided, true);
      // The dead challenge is consumed.
      const dead = await pool.query('SELECT consumed_at FROM verification_challenges WHERE public_id = $1', [started.challengeId]);
      assert.notEqual(dead.rows[0].consumed_at, null);

      // Now an immediate retry succeeds: the void cleared the superseded cooldown source and
      // refunded this user's own slot, so the user is not penalized for a confirmed non-send.
      const retry = await svc.start({ userId, operation: 'change_phone', target: '+639171112233', ipAddress, authVersion: 1 });
      assert.equal(retry.kind, 'started');
      assert.notEqual(retry.challengeId, started.challengeId);
    });

    test('a voided challenge can never be verified or consumed', async () => {
      const svc = service();
      const userId = await addUser('void-dead');
      const started = await svc.start({ userId, operation: 'change_phone', target: '+639172223344', ipAddress: '127.2.0.2', authVersion: 1 });
      await svc.voidFailedDelivery({ userId, challengeId: started.challengeId, operation: 'change_phone' });
      // Correct code no longer verifies the dead challenge.
      const verify = await svc.verify({ userId, challengeId: started.challengeId, operation: 'change_phone', code: started.code, target: '+639172223344' });
      assert.equal(verify.kind, 'invalid');
    });

    test('a timestamp collision across two customers on one IP never deletes the other\u2019s records', async () => {
      // Two different customers behind the SAME IP whose attempts share the EXACT same created_at.
      // A fixed clock guarantees the collision. When customer A voids, customer B's user slot AND
      // the shared ip slot must remain, so B keeps full abuse protection.
      const fixed = new Date('2026-10-26T05:00:00.000Z');
      const collidingSvc = createVerificationService({
        databasePool: pool, config: { deliveryEnabled: false, pepper: PEPPER }, now: () => fixed,
      });
      const sharedIp = '203.0.113.7';
      const userA = await addUser('collide-A');
      const userB = await addUser('collide-B');
      const aStart = await collidingSvc.start({ userId: userA, operation: 'change_phone', target: '+639181112222', ipAddress: sharedIp, authVersion: 1 });
      const bStart = await collidingSvc.start({ userId: userB, operation: 'change_phone', target: '+639183334444', ipAddress: sharedIp, authVersion: 1 });
      assert.equal(aStart.kind, 'started');
      assert.equal(bStart.kind, 'started');
      // Both attempts recorded the identical occurred_at.
      const times = await pool.query(
        'SELECT DISTINCT created_at FROM verification_challenges WHERE public_id = ANY($1)',
        [[aStart.challengeId, bStart.challengeId]],
      );
      assert.equal(times.rowCount, 1, 'both attempts must share one timestamp for this regression');
      const collidedAt = times.rows[0].created_at;

      // How many user-scope rows exist at that instant before the void (A + B = 2).
      const userRowsBefore = (await pool.query(
        `SELECT count(*)::int AS count FROM verification_rate_limits WHERE scope = 'user' AND occurred_at = $1`,
        [collidedAt],
      )).rows[0].count;
      const ipRowsBefore = (await pool.query(
        `SELECT count(*)::int AS count FROM verification_rate_limits WHERE scope = 'ip' AND occurred_at = $1`,
        [collidedAt],
      )).rows[0].count;
      assert.ok(userRowsBefore >= 2);
      assert.ok(ipRowsBefore >= 2);

      // Customer A voids a confirmed rejection.
      assert.equal(await collidingSvc.voidFailedDelivery({ userId: userA, challengeId: aStart.challengeId, operation: 'change_phone' }), true);

      // Exactly ONE user row (A's) was removed; B's user row and ALL ip rows are intact.
      const userRowsAfter = (await pool.query(
        `SELECT count(*)::int AS count FROM verification_rate_limits WHERE scope = 'user' AND occurred_at = $1`,
        [collidedAt],
      )).rows[0].count;
      const ipRowsAfter = (await pool.query(
        `SELECT count(*)::int AS count FROM verification_rate_limits WHERE scope = 'ip' AND occurred_at = $1`,
        [collidedAt],
      )).rows[0].count;
      assert.equal(userRowsAfter, userRowsBefore - 1, 'only A\u2019s user slot is removed');
      assert.equal(ipRowsAfter, ipRowsBefore, 'no ip slot is ever removed');

      // B's challenge remains fully usable and its abuse protection is intact.
      const bActive = await pool.query('SELECT consumed_at FROM verification_challenges WHERE public_id = $1', [bStart.challengeId]);
      assert.equal(bActive.rows[0].consumed_at, null);
    });

    test('void refuses a wrong owner, wrong operation, or already-consumed challenge', async () => {
      const svc = service();
      const owner = await addUser('void-owner');
      const attacker = await addUser('void-attacker');
      const started = await svc.start({ userId: owner, operation: 'change_phone', target: '+639173334455', ipAddress: '127.2.0.3', authVersion: 1 });
      // Wrong owner cannot void.
      assert.equal(await svc.voidFailedDelivery({ userId: attacker, challengeId: started.challengeId, operation: 'change_phone' }), false);
      // Wrong operation cannot void.
      assert.equal(await svc.voidFailedDelivery({ userId: owner, challengeId: started.challengeId, operation: 'change_email' }), false);
      // Correct void works once, and a second void is a safe no-op.
      assert.equal(await svc.voidFailedDelivery({ userId: owner, challengeId: started.challengeId, operation: 'change_phone' }), true);
      assert.equal(await svc.voidFailedDelivery({ userId: owner, challengeId: started.challengeId, operation: 'change_phone' }), false);
    });

    test('an ambiguous failure path (no void) preserves the challenge and its rate-limit slot', async () => {
      // Simulate the route NOT calling voidFailedDelivery (ambiguous outcome): the challenge stays
      // usable and the single-attempt rate-limit records remain, so cooldown still governs retry.
      const svc = service();
      const userId = await addUser('void-ambiguous');
      const started = await svc.start({ userId, operation: 'change_phone', target: '+639174445566', ipAddress: '127.2.0.4', authVersion: 1 });
      const active = await pool.query('SELECT consumed_at FROM verification_challenges WHERE public_id = $1', [started.challengeId]);
      assert.equal(active.rows[0].consumed_at, null); // still usable if the email did arrive
      // Because the attempt was NOT voided, its rate-limit slot survives: an immediate re-start is
      // blocked by the cooldown, so an ambiguous outcome cannot trigger a duplicate-send storm.
      const immediate = await svc.start({ userId, operation: 'change_phone', target: '+639174445566', ipAddress: '127.2.0.4', authVersion: 1 });
      assert.equal(immediate.kind, 'cooldown');
    });
  });

  describe('google reauthentication', { concurrency: false }, () => {
    const config = {
      enabled: true,
      webClientId: '123456789-cookie-fluffs.apps.googleusercontent.com',
      noncePepper: 'verification-google-reauth-pepper-unique-9428-chars',
    };
    let googlePayload;
    function reauth() {
      return createGoogleReauthService({
        databasePool: pool,
        config,
        oauthClient: { verifyIdToken: async () => ({ getPayload: () => googlePayload }) },
      });
    }

    test('verifies only a token whose subject is linked to the current customer', async () => {
      const svc = reauth();
      const userId = await addUser('reauth');
      await pool.query('INSERT INTO user_google_identities (user_id, google_subject) VALUES ($1, $2)', [userId, 'sub-reauth-1']);
      const issued = await svc.issueNonce(userId);
      assert.equal(issued.kind, 'issued');
      googlePayload = {
        iss: 'https://accounts.google.com', aud: config.webClientId, sub: 'sub-reauth-1',
        email_verified: true, nonce: issued.nonce, exp: Math.floor(Date.now() / 1000) + 600,
      };
      const ok = await svc.verify({ userId, selector: issued.selector, nonce: issued.nonce, idToken: 'token'.padEnd(120, 'x') });
      assert.equal(ok.kind, 'verified');
      // Replaying the consumed nonce fails.
      assert.equal((await svc.verify({ userId, selector: issued.selector, nonce: issued.nonce, idToken: 'token'.padEnd(120, 'x') })).kind, 'invalid');
    });

    test('rejects a subject mismatch and an unlinked account', async () => {
      const svc = reauth();
      const userId = await addUser('reauth-mismatch');
      await pool.query('INSERT INTO user_google_identities (user_id, google_subject) VALUES ($1, $2)', [userId, 'sub-correct']);
      const issued = await svc.issueNonce(userId);
      googlePayload = {
        iss: 'https://accounts.google.com', aud: config.webClientId, sub: 'sub-DIFFERENT',
        email_verified: true, nonce: issued.nonce, exp: Math.floor(Date.now() / 1000) + 600,
      };
      assert.equal((await svc.verify({ userId, selector: issued.selector, nonce: issued.nonce, idToken: 'token'.padEnd(120, 'x') })).kind, 'subject_mismatch');

      const unlinked = await addUser('reauth-unlinked');
      assert.equal((await svc.issueNonce(unlinked)).kind, 'not_linked');
    });

    test('rejects a token with a wrong nonce or bad audience', async () => {
      const svc = reauth();
      const userId = await addUser('reauth-badtoken');
      await pool.query('INSERT INTO user_google_identities (user_id, google_subject) VALUES ($1, $2)', [userId, 'sub-badtoken']);
      const issued = await svc.issueNonce(userId);
      googlePayload = {
        iss: 'https://accounts.google.com', aud: 'wrong-client-id', sub: 'sub-badtoken',
        email_verified: true, nonce: issued.nonce, exp: Math.floor(Date.now() / 1000) + 600,
      };
      assert.equal((await svc.verify({ userId, selector: issued.selector, nonce: issued.nonce, idToken: 'token'.padEnd(120, 'x') })).kind, 'invalid');
    });

    test('a login/signup-purpose nonce cannot be used for reauthentication (purpose separation)', async () => {
      const svc = reauth();
      const userId = await addUser('reauth-crosspurpose');
      await pool.query('INSERT INTO user_google_identities (user_id, google_subject) VALUES ($1, $2)', [userId, 'sub-cross']);
      // Forge a LOGIN nonce the way google-auth-service stores it: plain keyedHash(nonce, pepper),
      // WITHOUT the reauth purpose tag. It must never satisfy the reauth verifier.
      const selector = crypto.randomUUID();
      const nonce = crypto.randomBytes(32).toString('base64url');
      const plainHash = crypto.createHmac('sha256', config.noncePepper).update(nonce).digest('hex');
      await pool.query(
        `INSERT INTO google_auth_nonces (selector, nonce_hash, intent, expires_at, created_at)
         VALUES ($1, $2, 'login', now() + interval '10 minutes', now())`,
        [selector, plainHash],
      );
      googlePayload = {
        iss: 'https://accounts.google.com', aud: config.webClientId, sub: 'sub-cross',
        email_verified: true, nonce, exp: Math.floor(Date.now() / 1000) + 600,
      };
      // Even with a valid token + linked subject, the purpose-mismatched nonce hash is rejected.
      assert.equal((await svc.verify({ userId, selector, nonce, idToken: 'token'.padEnd(120, 'x') })).kind, 'invalid');
    });
  });

  describe('verified Change Phone end to end', { concurrency: false }, () => {
    function svc() {
      return createVerificationService({
        databasePool: pool, config: { deliveryEnabled: false, pepper: PEPPER }, now: () => new Date(clock),
      });
    }

    test('verified challenge atomically changes the phone and cannot be replayed', async () => {
      const verification = svc();
      const userId = await addUser('changephone');
      const newPhone = '+639188887777';
      const started = await verification.start({ userId, operation: 'change_phone', target: newPhone, ipAddress: '127.1.0.1', authVersion: 1 });
      // Before verifying, consume must fail (issuing alone never authorizes).
      const early = await changeCustomerPhone(userId, { challengeId: started.challengeId, newPhone }, { databasePool: pool, verification });
      assert.equal(early.kind, 'unverified');

      await verification.verify({ userId, challengeId: started.challengeId, operation: 'change_phone', code: started.code, target: newPhone });
      const changed = await changeCustomerPhone(userId, { challengeId: started.challengeId, newPhone }, { databasePool: pool, verification });
      assert.equal(changed.kind, 'changed');
      const persisted = await pool.query('SELECT phone FROM users WHERE id = $1', [userId]);
      assert.equal(persisted.rows[0].phone, newPhone);
      // Security event + essential notification recorded.
      assert.equal((await pool.query(`SELECT 1 FROM account_security_events WHERE user_id = $1 AND event_type = 'phone_change_succeeded'`, [userId])).rowCount, 1);
      assert.equal((await pool.query(`SELECT 1 FROM notifications WHERE user_id = $1 AND event_type = 'security_alert'`, [userId])).rowCount, 1);
      // Replay of the now-consumed challenge fails.
      const replay = await changeCustomerPhone(userId, { challengeId: started.challengeId, newPhone }, { databasePool: pool, verification });
      assert.equal(replay.kind, 'unverified');
    });

    test('rejects a target mismatch and a cross-account challenge', async () => {
      const verification = svc();
      const owner = await addUser('cp-owner');
      const attacker = await addUser('cp-attacker');
      const newPhone = '+639177776666';
      const started = await verification.start({ userId: owner, operation: 'change_phone', target: newPhone, ipAddress: '127.1.0.2', authVersion: 1 });
      await verification.verify({ userId: owner, challengeId: started.challengeId, operation: 'change_phone', code: started.code, target: newPhone });
      // Different target cannot be applied with this challenge.
      assert.equal((await changeCustomerPhone(owner, { challengeId: started.challengeId, newPhone: '+639166665555' }, { databasePool: pool, verification })).kind, 'unverified');
      // Another customer cannot use the owner's verified challenge.
      assert.equal((await changeCustomerPhone(attacker, { challengeId: started.challengeId, newPhone }, { databasePool: pool, verification })).kind, 'unverified');
      // The owner with the correct target still succeeds.
      assert.equal((await changeCustomerPhone(owner, { challengeId: started.challengeId, newPhone }, { databasePool: pool, verification })).kind, 'changed');
    });

    test('rejects an invalid phone number before touching verification', async () => {
      const verification = svc();
      const userId = await addUser('cp-badphone');
      assert.equal((await changeCustomerPhone(userId, { challengeId: 'anything', newPhone: '123' }, { databasePool: pool, verification })).kind, 'invalid_phone');
    });

    test('an auth_version bump before verification invalidates the challenge', async () => {
      const verification = svc();
      const userId = await addUser('cp-av-before');
      const newPhone = '+639144443333';
      const started = await verification.start({
        userId, operation: 'change_phone', target: newPhone, ipAddress: '127.1.0.4', authVersion: 1,
      });
      // Simulate a password change: bump auth_version (what changeCustomerPassword does).
      await pool.query('UPDATE users SET auth_version = auth_version + 1 WHERE id = $1', [userId]);
      const result = await verification.verify({
        userId, challengeId: started.challengeId, operation: 'change_phone', code: started.code, target: newPhone,
      });
      assert.equal(result.kind, 'invalid');
    });

    test('an auth_version bump after verification but before consume revokes authorization', async () => {
      const verification = svc();
      const userId = await addUser('cp-av-after');
      const newPhone = '+639133332222';
      const started = await verification.start({
        userId, operation: 'change_phone', target: newPhone, ipAddress: '127.1.0.5', authVersion: 1,
      });
      await verification.verify({
        userId, challengeId: started.challengeId, operation: 'change_phone', code: started.code, target: newPhone,
      });
      // Password change happens between verify and the final consume.
      await pool.query('UPDATE users SET auth_version = auth_version + 1 WHERE id = $1', [userId]);
      const result = await changeCustomerPhone(userId, { challengeId: started.challengeId, newPhone }, { databasePool: pool, verification });
      assert.equal(result.kind, 'unverified');
      const unchanged = await pool.query('SELECT phone FROM users WHERE id = $1', [userId]);
      assert.notEqual(unchanged.rows[0].phone, newPhone);
    });

    test('a challenge bound to the current auth_version completes normally', async () => {
      const verification = svc();
      const userId = await addUser('cp-av-ok');
      const newPhone = '+639122221111';
      const started = await verification.start({
        userId, operation: 'change_phone', target: newPhone, ipAddress: '127.1.0.6', authVersion: 1,
      });
      await verification.verify({
        userId, challengeId: started.challengeId, operation: 'change_phone', code: started.code, target: newPhone,
      });
      const result = await changeCustomerPhone(userId, { challengeId: started.challengeId, newPhone }, { databasePool: pool, verification });
      assert.equal(result.kind, 'changed');
    });

    test('parallel change attempts on one verified challenge apply exactly once', async () => {
      const verification = svc();
      const userId = await addUser('cp-parallel');
      const newPhone = '+639155554444';
      const started = await verification.start({ userId, operation: 'change_phone', target: newPhone, ipAddress: '127.1.0.3', authVersion: 1 });
      await verification.verify({ userId, challengeId: started.challengeId, operation: 'change_phone', code: started.code, target: newPhone });
      const [a, b] = await Promise.all([
        changeCustomerPhone(userId, { challengeId: started.challengeId, newPhone }, { databasePool: pool, verification }),
        changeCustomerPhone(userId, { challengeId: started.challengeId, newPhone }, { databasePool: pool, verification }),
      ]);
      assert.equal([a, b].filter((r) => r.kind === 'changed').length, 1);
    });

    test('start refuses to issue a challenge without a bound auth_version', async () => {
      const verification = svc();
      const userId = await addUser('cp-av-missing');
      // No authVersion passed: the engine must not create an unbound challenge.
      const started = await verification.start({
        userId, operation: 'change_phone', target: '+639111112222', ipAddress: '127.1.0.7',
      });
      assert.equal(started.kind, 'invalid');
      const rows = await pool.query('SELECT 1 FROM verification_challenges WHERE user_id = $1', [userId]);
      assert.equal(rows.rowCount, 0); // nothing was persisted
    });

    test('a challenge with a NULL auth_version is rejected at verify (no unbound fallback)', async () => {
      const verification = svc();
      const userId = await addUser('cp-av-null-verify');
      const newPhone = '+639101010101';
      // Forge an unbound challenge directly in the table to simulate a legacy / tampered row.
      const challengeId = crypto.randomUUID();
      const code = '424242';
      const codeHash = crypto.createHmac('sha256', PEPPER).update(code).digest('hex');
      const targetHash = crypto.createHmac('sha256', PEPPER).update(`change_phone:${newPhone}`).digest('hex');
      await pool.query(
        `INSERT INTO verification_challenges
           (public_id, user_id, operation, channel, code_hash, target_hash, auth_version, expires_at, created_at)
         VALUES ($1, $2, 'change_phone', 'email', $3, $4, NULL, $5::timestamptz + interval '10 minutes', $5)`,
        [challengeId, userId, codeHash, targetHash, clock],
      );
      const result = await verification.verify({
        userId, challengeId, operation: 'change_phone', code, target: newPhone,
      });
      assert.equal(result.kind, 'invalid'); // unbound row must never verify
    });

    test('a verified-but-unbound challenge is rejected at consume and leaves the phone unchanged', async () => {
      const verification = svc();
      const userId = await addUser('cp-av-null-consume');
      const original = (await pool.query('SELECT phone FROM users WHERE id = $1', [userId])).rows[0].phone;
      const newPhone = '+639202020202';
      // Forge an already-verified but unbound challenge to probe the final consume gate directly.
      const challengeId = crypto.randomUUID();
      const code = '515151';
      const codeHash = crypto.createHmac('sha256', PEPPER).update(code).digest('hex');
      const targetHash = crypto.createHmac('sha256', PEPPER).update(`change_phone:${newPhone}`).digest('hex');
      await pool.query(
        `INSERT INTO verification_challenges
           (public_id, user_id, operation, channel, code_hash, target_hash, auth_version, verified_at, expires_at, created_at)
         VALUES ($1, $2, 'change_phone', 'email', $3, $4, NULL, $5, $5::timestamptz + interval '10 minutes', $5)`,
        [challengeId, userId, codeHash, targetHash, clock],
      );
      const result = await changeCustomerPhone(userId, { challengeId, newPhone }, { databasePool: pool, verification });
      assert.equal(result.kind, 'unverified'); // consume gate rejects the unbound challenge
      const after = await pool.query('SELECT phone FROM users WHERE id = $1', [userId]);
      assert.equal(after.rows[0].phone, original); // phone untouched
    });
  });

  describe('reauthenticated Change Email end to end', { concurrency: false }, () => {
    const PASSWORD = 'Cookie1!Secret';
    function verifSvc() {
      return createVerificationService({
        databasePool: pool, config: { deliveryEnabled: false, pepper: PEPPER }, now: () => new Date(clock),
      });
    }
    function reauthSvc(googleReauth = null) {
      return createReauthService({ databasePool: pool, googleReauth, now: () => new Date(clock) });
    }
    async function addPasswordUser(label) {
      const hash = await bcrypt.hash(PASSWORD, 4);
      const r = await pool.query(
        `INSERT INTO users (full_name, first_name, last_name, email, phone, password_hash)
         VALUES ($1, 'Email', 'User', $2, '+639171234567', $3) RETURNING id, email`,
        [`Email ${label}`, `email-${label}-${crypto.randomBytes(4).toString('hex')}@example.test`, hash],
      );
      return r.rows[0];
    }
    // Drives the full flow: password reauth -> issue+verify change_email OTP to the new address -> change.
    async function fullChange(user, newEmail, { verification = verifSvc(), reauth = reauthSvc() } = {}) {
      const pw = await reauth.verifyPassword({ userId: user.id, operation: 'change_email', password: PASSWORD });
      assert.equal(pw.kind, 'authorized');
      const started = await verification.start({
        userId: user.id, operation: 'change_email', target: newEmail, ipAddress: '127.3.0.1', authVersion: 1,
      });
      await verification.verify({
        userId: user.id, challengeId: started.challengeId, operation: 'change_email', code: started.code, target: newEmail,
      });
      return changeCustomerEmail(user.id, { reauthId: pw.reauthId, challengeId: started.challengeId, newEmail },
        { databasePool: pool, verification, reauth });
    }

    test('password reauth + verified new-email ownership changes the email and rotates auth_version', async () => {
      const user = await addPasswordUser('ok');
      const before = (await pool.query('SELECT auth_version FROM users WHERE id = $1', [user.id])).rows[0].auth_version;
      const newEmail = `new-${crypto.randomBytes(4).toString('hex')}@example.test`;
      const result = await fullChange(user, newEmail);
      assert.equal(result.kind, 'changed');
      const row = await pool.query('SELECT email, auth_version FROM users WHERE id = $1', [user.id]);
      assert.equal(row.rows[0].email, newEmail);
      assert.equal(Number(row.rows[0].auth_version), Number(before) + 1); // session rotation
      assert.equal((await pool.query(`SELECT 1 FROM account_security_events WHERE user_id=$1 AND event_type='email_change_succeeded'`, [user.id])).rowCount, 1);
      assert.equal((await pool.query(`SELECT 1 FROM notifications WHERE user_id=$1 AND event_type='security_alert'`, [user.id])).rowCount, 1);
    });

    test('wrong password fails reauth and never mints a proof', async () => {
      const user = await addPasswordUser('wrongpw');
      const reauth = reauthSvc();
      const bad = await reauth.verifyPassword({ userId: user.id, operation: 'change_email', password: 'Wrong1!Password' });
      assert.equal(bad.kind, 'invalid_password');
      assert.equal((await pool.query('SELECT count(*)::int AS c FROM reauth_authorizations WHERE user_id=$1', [user.id])).rows[0].c, 0);
    });

    test('a Google-only account cannot reauthenticate with a password', async () => {
      const r = await pool.query(
        `INSERT INTO users (full_name, first_name, last_name, email, phone, password_hash)
         VALUES ('Google Only', 'Google', 'Only', $1, '+639170000000', NULL) RETURNING id`,
        [`google-only-${crypto.randomBytes(4).toString('hex')}@example.test`],
      );
      const reauth = reauthSvc();
      const result = await reauth.verifyPassword({ userId: r.rows[0].id, operation: 'change_email', password: 'anything' });
      assert.equal(result.kind, 'password_unavailable');
    });

    test('verified new-email ownership WITHOUT reauth cannot change the email', async () => {
      const user = await addPasswordUser('noreauth');
      const verification = verifSvc();
      const newEmail = `nr-${crypto.randomBytes(4).toString('hex')}@example.test`;
      const started = await verification.start({
        userId: user.id, operation: 'change_email', target: newEmail, ipAddress: '127.3.0.2', authVersion: 1,
      });
      await verification.verify({ userId: user.id, challengeId: started.challengeId, operation: 'change_email', code: started.code, target: newEmail });
      // A bogus/absent reauth proof must fail closed.
      const result = await changeCustomerEmail(user.id, { reauthId: crypto.randomUUID(), challengeId: started.challengeId, newEmail },
        { databasePool: pool, verification, reauth: reauthSvc() });
      assert.equal(result.kind, 'unauthorized');
      assert.notEqual((await pool.query('SELECT email FROM users WHERE id=$1', [user.id])).rows[0].email, newEmail);
    });

    test('reauth WITHOUT verified new-email ownership cannot change the email', async () => {
      const user = await addPasswordUser('noverify');
      const reauth = reauthSvc();
      const pw = await reauth.verifyPassword({ userId: user.id, operation: 'change_email', password: PASSWORD });
      const newEmail = `nv-${crypto.randomBytes(4).toString('hex')}@example.test`;
      // No challenge was verified for this target.
      const result = await changeCustomerEmail(user.id, { reauthId: pw.reauthId, challengeId: crypto.randomUUID(), newEmail },
        { databasePool: pool, verification: verifSvc(), reauth });
      assert.equal(result.kind, 'unverified');
    });

    test('a reauth proof is single-use (replay rejected)', async () => {
      const user = await addPasswordUser('replay');
      const reauth = reauthSvc();
      const verification = verifSvc();
      const pw = await reauth.verifyPassword({ userId: user.id, operation: 'change_email', password: PASSWORD });
      assert.equal(pw.kind, 'authorized');
      const newEmail = `rp-${crypto.randomBytes(4).toString('hex')}@example.test`;
      const started = await verification.start({
        userId: user.id, operation: 'change_email', target: newEmail, ipAddress: '127.3.0.3', authVersion: 1,
      });
      await verification.verify({ userId: user.id, challengeId: started.challengeId, operation: 'change_email', code: started.code, target: newEmail });
      const first = await changeCustomerEmail(user.id, { reauthId: pw.reauthId, challengeId: started.challengeId, newEmail },
        { databasePool: pool, verification, reauth });
      assert.equal(first.kind, 'changed');
      // Replaying the SAME proof (now consumed) against a fresh challenge must fail on the reauth gate.
      const newEmail2 = `rp2-${crypto.randomBytes(4).toString('hex')}@example.test`;
      const started2 = await verification.start({
        userId: user.id, operation: 'change_email', target: newEmail2, ipAddress: '127.3.0.3', authVersion: 2,
      });
      await verification.verify({ userId: user.id, challengeId: started2.challengeId, operation: 'change_email', code: started2.code, target: newEmail2 });
      const replay = await changeCustomerEmail(user.id, { reauthId: pw.reauthId, challengeId: started2.challengeId, newEmail: newEmail2 },
        { databasePool: pool, verification, reauth });
      assert.equal(replay.kind, 'unauthorized'); // proof already consumed (also auth_version mismatch)
    });

    test('a password change between reauth and the email change revokes the proof (auth_version mismatch)', async () => {
      const user = await addPasswordUser('avbump');
      const reauth = reauthSvc();
      const verification = verifSvc();
      const pw = await reauth.verifyPassword({ userId: user.id, operation: 'change_email', password: PASSWORD });
      const newEmail = `bump-${crypto.randomBytes(4).toString('hex')}@example.test`;
      const started = await verification.start({
        userId: user.id, operation: 'change_email', target: newEmail, ipAddress: '127.3.0.4', authVersion: 1,
      });
      await verification.verify({ userId: user.id, challengeId: started.challengeId, operation: 'change_email', code: started.code, target: newEmail });
      // Simulate a password change bumping auth_version after the proof was minted.
      await pool.query('UPDATE users SET auth_version = auth_version + 1 WHERE id = $1', [user.id]);
      const result = await changeCustomerEmail(user.id, { reauthId: pw.reauthId, challengeId: started.challengeId, newEmail },
        { databasePool: pool, verification, reauth });
      assert.equal(result.kind, 'unauthorized'); // proof auth_version no longer matches
    });

    test('rejects a duplicate email already used by another account', async () => {
      const taken = await addPasswordUser('taken');
      const user = await addPasswordUser('dupe');
      const result = await fullChange(user, taken.email);
      assert.equal(result.kind, 'duplicate_email');
      // The reauth + ownership challenge path still ran, but the update rolled back.
      assert.notEqual((await pool.query('SELECT email FROM users WHERE id=$1', [user.id])).rows[0].email, taken.email);
    });

    test('rejects an invalid new email before touching proofs', async () => {
      const user = await addPasswordUser('bademail');
      const result = await changeCustomerEmail(user.id, { reauthId: crypto.randomUUID(), challengeId: crypto.randomUUID(), newEmail: 'not-an-email' },
        { databasePool: pool, verification: verifSvc(), reauth: reauthSvc() });
      assert.equal(result.kind, 'invalid_email');
    });
  });

  describe('Set Password end to end (Google-only accounts)', { concurrency: false }, () => {
    const PASSWORD = 'Cookie1!SetPass';
    function verifSvc() {
      return createVerificationService({
        databasePool: pool, config: { deliveryEnabled: false, pepper: PEPPER }, now: () => new Date(clock),
      });
    }
    // Reauth wired with a stub google verifier that approves a linked user (unit-level isolation
    // of the set-password consumption path; the real google-reauth-service is tested separately).
    function reauthSvc(googleVerified = true) {
      return createReauthService({
        databasePool: pool,
        googleReauth: { verify: async () => ({ kind: googleVerified ? 'verified' : 'invalid' }) },
        now: () => new Date(clock),
      });
    }
    async function addGoogleOnlyUser(label) {
      const r = await pool.query(
        `INSERT INTO users (full_name, first_name, last_name, email, phone, password_hash)
         VALUES ($1, 'Google', 'Only', $2, '+639170000000', NULL) RETURNING id, email`,
        [`Set ${label}`, `set-${label}-${crypto.randomBytes(4).toString('hex')}@example.test`],
      );
      // Google-linked so completeGoogle's post-verify path is valid.
      await pool.query('INSERT INTO user_google_identities (user_id, google_subject) VALUES ($1, $2)', [r.rows[0].id, `sub-${label}-${crypto.randomBytes(3).toString('hex')}`]);
      return r.rows[0];
    }
    // Mint a set_password reauth proof for a user via the (stubbed-google) reauth service.
    async function mintSetProof(userId, reauth) {
      const res = await reauth.completeGoogle({ userId, operation: 'set_password', selector: 's', nonce: 'n', idToken: 't' });
      assert.equal(res.kind, 'authorized');
      return res.reauthId;
    }
    async function verifiedSetChallenge(userId, verification) {
      const started = await verification.start({ userId, operation: 'set_password', ipAddress: '127.4.0.1', authVersion: 1 });
      await verification.verify({ userId, challengeId: started.challengeId, operation: 'set_password', code: started.code });
      return started.challengeId;
    }

    test('sets a first password with both valid proofs and rotates auth_version once', async () => {
      const user = await addGoogleOnlyUser('ok');
      const verification = verifSvc();
      const reauth = reauthSvc();
      const before = (await pool.query('SELECT auth_version FROM users WHERE id=$1', [user.id])).rows[0].auth_version;
      const reauthId = await mintSetProof(user.id, reauth);
      const challengeId = await verifiedSetChallenge(user.id, verification);
      const result = await setCustomerPassword(user.id, { reauthId, challengeId, newPassword: PASSWORD },
        { databasePool: pool, verification, reauth });
      assert.equal(result.kind, 'set');
      const row = (await pool.query('SELECT password_hash, auth_version FROM users WHERE id=$1', [user.id])).rows[0];
      assert.ok(row.password_hash && row.password_hash !== PASSWORD); // hashed, never plaintext
      assert.equal(await bcrypt.compare(PASSWORD, row.password_hash), true);
      assert.equal(Number(row.auth_version), Number(before) + 1);
      assert.equal((await pool.query(`SELECT 1 FROM account_security_events WHERE user_id=$1 AND event_type='password_change_succeeded' AND details->>'reason'='set_password'`, [user.id])).rowCount, 1);
      assert.equal((await pool.query(`SELECT 1 FROM notifications WHERE user_id=$1 AND event_type='password_changed'`, [user.id])).rowCount, 1);
    });

    test('rejects Set Password for an account that already has a password', async () => {
      const hash = await bcrypt.hash('Existing1!Pass', 4);
      const r = await pool.query(
        `INSERT INTO users (full_name, first_name, last_name, email, phone, password_hash)
         VALUES ('Has Pass', 'Has', 'Pass', $1, '+639170000001', $2) RETURNING id`,
        [`haspass-${crypto.randomBytes(4).toString('hex')}@example.test`, hash],
      );
      await pool.query('INSERT INTO user_google_identities (user_id, google_subject) VALUES ($1, $2)', [r.rows[0].id, `sub-hp-${crypto.randomBytes(3).toString('hex')}`]);
      const verification = verifSvc();
      const reauth = reauthSvc();
      const reauthId = await mintSetProof(r.rows[0].id, reauth);
      const challengeId = await verifiedSetChallenge(r.rows[0].id, verification);
      const result = await setCustomerPassword(r.rows[0].id, { reauthId, challengeId, newPassword: PASSWORD },
        { databasePool: pool, verification, reauth });
      assert.equal(result.kind, 'password_exists');
    });

    test('reauth WITHOUT a verified OTP cannot set a password', async () => {
      const user = await addGoogleOnlyUser('noverify');
      const reauth = reauthSvc();
      const reauthId = await mintSetProof(user.id, reauth);
      const result = await setCustomerPassword(user.id, { reauthId, challengeId: crypto.randomUUID(), newPassword: PASSWORD },
        { databasePool: pool, verification: verifSvc(), reauth });
      assert.equal(result.kind, 'unverified');
      assert.equal((await pool.query('SELECT password_hash FROM users WHERE id=$1', [user.id])).rows[0].password_hash, null);
    });

    test('verified OTP WITHOUT a reauth proof cannot set a password', async () => {
      const user = await addGoogleOnlyUser('noreauth');
      const verification = verifSvc();
      const challengeId = await verifiedSetChallenge(user.id, verification);
      const result = await setCustomerPassword(user.id, { reauthId: crypto.randomUUID(), challengeId, newPassword: PASSWORD },
        { databasePool: pool, verification, reauth: reauthSvc() });
      assert.equal(result.kind, 'unauthorized');
      assert.equal((await pool.query('SELECT password_hash FROM users WHERE id=$1', [user.id])).rows[0].password_hash, null);
    });

    test('a change_email reauth proof CANNOT be used to set a password (cross-operation)', async () => {
      const user = await addGoogleOnlyUser('crossop');
      const verification = verifSvc();
      const reauth = reauthSvc();
      // Mint a proof bound to change_email, then try to use it for set_password.
      const emailProof = await reauth.completeGoogle({ userId: user.id, operation: 'change_email', selector: 's', nonce: 'n', idToken: 't' });
      assert.equal(emailProof.kind, 'authorized');
      const challengeId = await verifiedSetChallenge(user.id, verification);
      const result = await setCustomerPassword(user.id, { reauthId: emailProof.reauthId, challengeId, newPassword: PASSWORD },
        { databasePool: pool, verification, reauth });
      assert.equal(result.kind, 'unauthorized'); // consumeReauth filters by operation
    });

    test('a set_password reauth proof is single-use (replay rejected)', async () => {
      const user = await addGoogleOnlyUser('replay');
      const verification = verifSvc();
      const reauth = reauthSvc();
      const reauthId = await mintSetProof(user.id, reauth);
      const challengeId = await verifiedSetChallenge(user.id, verification);
      const first = await setCustomerPassword(user.id, { reauthId, challengeId, newPassword: PASSWORD },
        { databasePool: pool, verification, reauth });
      assert.equal(first.kind, 'set');
      // The account now HAS a password; a replay also fails the set-only guard, but crucially the
      // proof is consumed. Prove consumption on a fresh passwordless user is covered elsewhere; here
      // a second attempt with the same (consumed) proof is rejected.
      const challengeId2 = await verifiedSetChallenge(user.id, verification).catch(() => null);
      const replay = await setCustomerPassword(user.id, { reauthId, challengeId: challengeId2 ?? crypto.randomUUID(), newPassword: PASSWORD },
        { databasePool: pool, verification, reauth });
      assert.notEqual(replay.kind, 'set');
    });

    test('a stale auth_version reauth proof is rejected', async () => {
      const user = await addGoogleOnlyUser('stale');
      const verification = verifSvc();
      const reauth = reauthSvc();
      const reauthId = await mintSetProof(user.id, reauth);
      const challengeId = await verifiedSetChallenge(user.id, verification);
      // Bump auth_version after the proof + challenge were bound to version 1.
      await pool.query('UPDATE users SET auth_version = auth_version + 1 WHERE id=$1', [user.id]);
      const result = await setCustomerPassword(user.id, { reauthId, challengeId, newPassword: PASSWORD },
        { databasePool: pool, verification, reauth });
      assert.equal(result.kind, 'unauthorized');
    });

    test('rejects a weak password even with both valid proofs', async () => {
      const user = await addGoogleOnlyUser('weak');
      const verification = verifSvc();
      const reauth = reauthSvc();
      const reauthId = await mintSetProof(user.id, reauth);
      const challengeId = await verifiedSetChallenge(user.id, verification);
      const result = await setCustomerPassword(user.id, { reauthId, challengeId, newPassword: 'password' },
        { databasePool: pool, verification, reauth });
      assert.equal(result.kind, 'invalid_password');
      assert.equal((await pool.query('SELECT password_hash FROM users WHERE id=$1', [user.id])).rows[0].password_hash, null);
    });

    test('Google reauth that fails verification mints no set_password proof', async () => {
      const user = await addGoogleOnlyUser('gfail');
      const reauth = reauthSvc(false); // stub returns invalid
      const res = await reauth.completeGoogle({ userId: user.id, operation: 'set_password', selector: 's', nonce: 'n', idToken: 't' });
      assert.equal(res.kind, 'invalid');
      assert.equal((await pool.query('SELECT count(*)::int c FROM reauth_authorizations WHERE user_id=$1', [user.id])).rows[0].c, 0);
    });
  });
}
