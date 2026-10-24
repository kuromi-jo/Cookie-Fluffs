/**
 * @file account-features-integration.test.js
 * @description Opt-in isolated PostgreSQL coverage for P4C favorites and preferences.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test, { after, before, describe } from 'node:test';
import pg from 'pg';

const configuredUrl = process.env.TEST_DATABASE_URL;
const databaseUrl = process.env.DATABASE_URL;

if (!configuredUrl) {
  test('real PostgreSQL P4C integration', { skip: 'Set TEST_DATABASE_URL to an isolated loopback database.' }, () => {});
} else {
  const parsed = new URL(configuredUrl);
  if (!['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname) || configuredUrl !== databaseUrl
    || !/(?:test|sandbox)/i.test(parsed.pathname.slice(1))) {
    throw new Error('P4C integration tests require matching loopback test or sandbox database URLs.');
  }

  const temporaryName = `cookie_fluffs_account_it_${process.pid}_${crypto.randomBytes(5).toString('hex')}`;
  const adminUrl = new URL(configuredUrl);
  adminUrl.pathname = '/postgres';
  adminUrl.search = '';
  const temporaryUrl = new URL(configuredUrl);
  temporaryUrl.pathname = `/${temporaryName}`;
  const quotedName = `"${temporaryName.replaceAll('"', '""')}"`;
  const admin = new pg.Pool({ connectionString: adminUrl.toString(), ssl: false, max: 1 });
  let pool;
  let ownerId;
  let otherId;

  before(async () => {
    await admin.query(`CREATE DATABASE ${quotedName}`);
    process.env.DATABASE_URL = temporaryUrl.toString();
    process.env.TEST_DATABASE_URL = temporaryUrl.toString();
    const db = await import(`./db.js?account-it=${temporaryName}`);
    pool = db.pool;
    await db.initDb();
    const users = await pool.query(
      `INSERT INTO users (full_name, first_name, last_name, email, phone, password_hash)
       VALUES ('Favorite Owner', 'Favorite', 'Owner', 'favorite-owner@example.test', '+639171234567', 'test'),
              ('Other Owner', 'Other', 'Owner', 'favorite-other@example.test', '+639181234567', 'test')
       RETURNING id`,
    );
    [ownerId, otherId] = users.rows.map((row) => row.id);
  });

  after(async () => {
    await pool?.end();
    await admin.query(`DROP DATABASE IF EXISTS ${quotedName}`);
    await admin.end();
  });

  describe('real PostgreSQL P4C account features', { concurrency: false }, () => {
    test('migration is idempotent and records its marker', async () => {
      const db = await import(`./db.js?account-it=${temporaryName}`);
      await db.initDb();
      const marker = await pool.query("SELECT value FROM app_meta WHERE key = 'favorites_preferences_v1'");
      assert.equal(marker.rowCount, 1);
    });

    test('favorite primary key prevents duplicates and ownership stays isolated', async () => {
      const product = await pool.query('SELECT id FROM products WHERE is_available ORDER BY id LIMIT 1');
      const productId = product.rows[0].id;
      await pool.query(
        `INSERT INTO user_favorites (user_id, product_id) VALUES ($1, $2)
         ON CONFLICT (user_id, product_id) DO NOTHING`,
        [ownerId, productId],
      );
      await pool.query(
        `INSERT INTO user_favorites (user_id, product_id) VALUES ($1, $2)
         ON CONFLICT (user_id, product_id) DO NOTHING`,
        [ownerId, productId],
      );
      const owner = await pool.query('SELECT count(*)::int AS count FROM user_favorites WHERE user_id = $1', [ownerId]);
      const other = await pool.query('SELECT count(*)::int AS count FROM user_favorites WHERE user_id = $1', [otherId]);
      assert.equal(owner.rows[0].count, 1);
      assert.equal(other.rows[0].count, 0);
    });

    test('unavailable favorites remain and hard-deleted products cascade', async () => {
      const inserted = await pool.query(
        `INSERT INTO products
          (slug, name, tagline, description, flavor_notes, category, price, image_url, is_available)
         VALUES ($1, 'Temporary Cookie', 'Test', 'Test', 'Test', 'classic', 10, '/test.webp', false)
         RETURNING id`,
        [`temporary-${crypto.randomUUID()}`],
      );
      const productId = inserted.rows[0].id;
      await pool.query('INSERT INTO user_favorites (user_id, product_id) VALUES ($1, $2)', [ownerId, productId]);
      const unavailable = await pool.query(
        `SELECT p.is_available FROM user_favorites f JOIN products p ON p.id = f.product_id
         WHERE f.user_id = $1 AND f.product_id = $2`,
        [ownerId, productId],
      );
      assert.equal(unavailable.rows[0].is_available, false);
      await pool.query('DELETE FROM products WHERE id = $1', [productId]);
      const remaining = await pool.query('SELECT 1 FROM user_favorites WHERE product_id = $1', [productId]);
      assert.equal(remaining.rowCount, 0);
    });

    test('preferences upsert one durable row per owner', async () => {
      await pool.query(
        `INSERT INTO user_preferences (user_id, reduce_motion, larger_text) VALUES ($1, true, false)
         ON CONFLICT (user_id) DO UPDATE SET reduce_motion = EXCLUDED.reduce_motion,
           larger_text = EXCLUDED.larger_text, updated_at = now()`,
        [ownerId],
      );
      await pool.query(
        `INSERT INTO user_preferences (user_id, reduce_motion, larger_text) VALUES ($1, false, true)
         ON CONFLICT (user_id) DO UPDATE SET reduce_motion = EXCLUDED.reduce_motion,
           larger_text = EXCLUDED.larger_text, updated_at = now()`,
        [ownerId],
      );
      const result = await pool.query(
        'SELECT reduce_motion, larger_text FROM user_preferences WHERE user_id = $1',
        [ownerId],
      );
      assert.equal(result.rowCount, 1);
      assert.deepEqual(result.rows[0], { reduce_motion: false, larger_text: true });
    });
  });
}
