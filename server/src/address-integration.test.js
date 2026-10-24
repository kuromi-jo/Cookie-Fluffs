/**
 * @file address-integration.test.js
 * @description Opt-in isolated PostgreSQL address-book migration, ownership, and concurrency tests.
 */
import test, { after, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import pg from 'pg';

const configuredUrl = process.env.TEST_DATABASE_URL;
const databaseUrl = process.env.DATABASE_URL;

if (!configuredUrl) {
  test('real PostgreSQL address integration', { skip: 'Set TEST_DATABASE_URL to an isolated loopback database.' }, () => {});
} else {
  const parsed = new URL(configuredUrl);
  if (!['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname) || configuredUrl !== databaseUrl
    || !/(?:test|sandbox)/i.test(parsed.pathname.slice(1))) {
    throw new Error('Address integration tests require matching loopback test or sandbox database URLs.');
  }

  const temporaryName = `cookie_fluffs_address_it_${process.pid}_${crypto.randomBytes(5).toString('hex')}`;
  const adminUrl = new URL(configuredUrl);
  adminUrl.pathname = '/postgres';
  adminUrl.search = '';
  const temporaryUrl = new URL(configuredUrl);
  temporaryUrl.pathname = `/${temporaryName}`;
  const quotedName = `"${temporaryName.replaceAll('"', '""')}"`;
  const admin = new pg.Pool({ connectionString: adminUrl.toString(), ssl: false, max: 1 });
  let pool;
  let createAddress;
  let updateAddress;
  let setDefaultAddress;
  let deleteAddress;
  let listAddresses;
  let ownerId;
  let otherId;

  const address = (label, makeDefault = false) => ({
    label, recipientName: 'Integration Customer', recipientPhone: '+639171234567',
    addressLine1: `${label} Cookie Street`, addressLine2: '', regionCode: '1300000000',
    region: 'National Capital Region (NCR)', province: 'Metro Manila', cityCode: '1381300000',
    city: 'Quezon City', barangayCode: '1381300001', barangay: 'Alicia', postalCode: '1100', makeDefault,
  });

  before(async () => {
    await admin.query(`CREATE DATABASE ${quotedName}`);
    process.env.DATABASE_URL = temporaryUrl.toString();
    process.env.TEST_DATABASE_URL = temporaryUrl.toString();
    const db = await import(`./db.js?address-it=${temporaryName}`);
    ({ createAddress, updateAddress, setDefaultAddress, deleteAddress, listAddresses } = await import('./address-service.js'));
    pool = db.pool;
    await db.initDb();
    const users = await pool.query(
      `INSERT INTO users (full_name, first_name, last_name, email, phone, password_hash)
       VALUES ('Address Owner', 'Address', 'Owner', 'address-owner@example.test', '+639171234567', 'test'),
              ('Other Owner', 'Other', 'Owner', 'other-owner@example.test', '+639181234567', 'test')
       RETURNING id`,
    );
    [ownerId, otherId] = users.rows.map((row) => row.id);
  });

  after(async () => {
    await pool?.end();
    await admin.query(`DROP DATABASE IF EXISTS ${quotedName}`);
    await admin.end();
  });

  describe('real PostgreSQL saved addresses', { concurrency: false }, () => {
    test('migration is idempotent and first address becomes default', async () => {
      const db = await import(`./db.js?address-it=${temporaryName}`);
      await db.initDb();
      const client = await pool.connect();
      try {
        const created = await createAddress(client, ownerId, address('Home'));
        assert.equal(created.isDefault, true);
        assert.match(created.id, /^[0-9a-f-]{36}$/);
        const updated = await updateAddress(client, ownerId, created.id, address('Home updated'));
        assert.equal(updated.label, 'Home updated');
      } finally { client.release(); }
    });

    test('rolls back a failed address write without consuming a slot', async () => {
      const before = await pool.query('SELECT count(*)::int AS count FROM customer_addresses WHERE user_id = $1', [ownerId]);
      const client = await pool.connect();
      try {
        await assert.rejects(createAddress(client, ownerId, { ...address('Broken'), postalCode: 'bad' }));
      } finally { client.release(); }
      const afterFailure = await pool.query('SELECT count(*)::int AS count FROM customer_addresses WHERE user_id = $1', [ownerId]);
      assert.equal(afterFailure.rows[0].count, before.rows[0].count);
    });

    test('concurrent default changes serialize to exactly one default', async () => {
      const firstClient = await pool.connect();
      const secondClient = await pool.connect();
      let first;
      let second;
      try {
        first = await createAddress(firstClient, ownerId, address('Work'));
        second = await createAddress(secondClient, ownerId, address('Family'));
      } finally { firstClient.release(); secondClient.release(); }
      await Promise.all([first, second].map(async (entry) => {
        const client = await pool.connect();
        try { await setDefaultAddress(client, ownerId, entry.id); } finally { client.release(); }
      }));
      const result = await pool.query('SELECT count(*)::int AS count FROM customer_addresses WHERE user_id = $1 AND is_default', [ownerId]);
      assert.equal(result.rows[0].count, 1);
    });

    test('unowned updates return not found and default deletion promotes deterministically', async () => {
      const client = await pool.connect();
      try {
        const current = (await listAddresses(client, ownerId)).find((entry) => entry.isDefault);
        await assert.rejects(updateAddress(client, otherId, current.id, address('Changed')), /not found/i);
        await deleteAddress(client, ownerId, current.id);
        const remaining = await listAddresses(client, ownerId);
        assert.equal(remaining.filter((entry) => entry.isDefault).length, 1);
      } finally { client.release(); }
    });

    test('enforces ten addresses and leaves historical order snapshots unchanged', async () => {
      let rows = await pool.query('SELECT count(*)::int AS count FROM customer_addresses WHERE user_id = $1', [ownerId]);
      while (rows.rows[0].count < 10) {
        const client = await pool.connect();
        try { await createAddress(client, ownerId, address(`Place ${rows.rows[0].count + 1}`)); } finally { client.release(); }
        rows = await pool.query('SELECT count(*)::int AS count FROM customer_addresses WHERE user_id = $1', [ownerId]);
      }
      const extraClient = await pool.connect();
      try { await assert.rejects(createAddress(extraClient, ownerId, address('Extra')), /up to 10/i); } finally { extraClient.release(); }

      const saved = (await pool.query('SELECT public_id FROM customer_addresses WHERE user_id = $1 LIMIT 1', [ownerId])).rows[0];
      const orderId = crypto.randomUUID();
      await pool.query(
        `INSERT INTO orders
          (public_id, user_id, idempotency_key, request_fingerprint, fulfillment_method, payment_method,
           payment_status, order_status, scheduling_mode, contact_name, contact_phone, address_line_1,
           address_line_2, barangay, city, province, postal_code, merchandise_subtotal, promotion_discount,
           pack_discount, discount_total, delivery_fee, order_total, currency)
         VALUES ($1, $2, $3, $4, 'delivery', 'cash_on_delivery', 'pending', 'placed', 'asap',
           'Snapshot Customer', '+639171234567', 'Original Street', '', 'Alicia', 'Quezon City',
           'Metro Manila', '1100', 100, 0, 0, 0, 49, 149, 'PHP')`,
        [orderId, ownerId, crypto.randomUUID(), 'a'.repeat(64)],
      );
      await pool.query(`UPDATE customer_addresses SET address_line_1 = 'Changed Street' WHERE public_id = $1`, [saved.public_id]);
      await pool.query('DELETE FROM customer_addresses WHERE public_id = $1', [saved.public_id]);
      const order = await pool.query('SELECT address_line_1 FROM orders WHERE public_id = $1', [orderId]);
      assert.equal(order.rows[0].address_line_1, 'Original Street');
    });
  });
}
