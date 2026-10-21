/**
 * @file order-integration.test.js
 * @description Opt-in real PostgreSQL migration, order transaction and concurrency tests.
 */
import test, { after, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import pg from 'pg';
import { initDb, pool as appPool } from './db.js';
import { lockUserCart } from './cart-lock.js';
import { createOrder, getOrderByPublicId } from './order-service.js';
import { orderRequestFingerprint } from './order-validation.js';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const databaseUrl = process.env.DATABASE_URL;

if (!testDatabaseUrl) {
  test('real PostgreSQL order integration', { skip: 'Set TEST_DATABASE_URL to an isolated loopback database.' }, () => {});
} else {
  const parsedUrl = new URL(testDatabaseUrl);
  if (!['localhost', '127.0.0.1', '[::1]'].includes(parsedUrl.hostname) || databaseUrl !== testDatabaseUrl) {
    throw new Error('Integration tests require matching DATABASE_URL and TEST_DATABASE_URL on a loopback host.');
  }

  const { Pool } = pg;
  const pool = new Pool({ connectionString: testDatabaseUrl, ssl: false, max: 20 });
  let fixtureNumber = 0;

  const deliveryCheckout = (overrides = {}) => ({
    idempotencyKey: crypto.randomUUID(),
    fulfillmentMethod: 'delivery',
    paymentMethod: 'cash_on_delivery',
    schedulingMode: 'asap',
    contactName: 'Integration Customer',
    contactPhone: '+639171234567',
    deliveryAddress: {
      addressLine1: '12 Test Street',
      addressLine2: '',
      barangay: 'Test Barangay',
      city: 'Quezon City',
      province: 'Metro Manila',
      postalCode: '1100',
    },
    notes: '',
    ...overrides,
  });

  const pickupCheckout = (overrides = {}) => deliveryCheckout({
    fulfillmentMethod: 'pickup',
    paymentMethod: 'cash_on_pickup',
    deliveryAddress: null,
    ...overrides,
  });

  async function resetFixtures() {
    await pool.query('DELETE FROM orders');
    await pool.query('DELETE FROM cart_items');
    await pool.query('DELETE FROM cart_boxes');
    await pool.query("DELETE FROM users WHERE email LIKE 'p2a11-%@example.test'");
    await pool.query("DELETE FROM products WHERE slug LIKE 'p2a11-%'");
  }

  async function addUser(label = 'customer') {
    fixtureNumber += 1;
    const result = await pool.query(
      `INSERT INTO users (full_name, first_name, last_name, email, phone, password_hash)
       VALUES ($1, 'Integration', 'Customer', $2, '+639171234567', 'test-only') RETURNING id`,
      [`Integration ${label}`, `p2a11-${fixtureNumber}-${label}@example.test`],
    );
    return result.rows[0].id;
  }

  async function addProduct({ label = 'cookie', price = '100.00', salePrice = null, available = true } = {}) {
    fixtureNumber += 1;
    const result = await pool.query(
      `INSERT INTO products
         (slug, name, tagline, description, flavor_notes, category, price, sale_price, image_url, is_available)
       VALUES ($1, $2, 'Test tagline', 'Test description', 'Test notes', 'Classic', $3, $4, '/test.webp', $5)
       RETURNING id`,
      [`p2a11-${fixtureNumber}-${label}`, `Integration ${label}`, price, salePrice, available],
    );
    return result.rows[0].id;
  }

  async function addSingle(userId, productId, { quantity = 1, selected = true } = {}) {
    await pool.query(
      'INSERT INTO cart_items (user_id, product_id, quantity, selected) VALUES ($1, $2, $3, $4)',
      [userId, productId, quantity, selected],
    );
  }

  async function addBox(userId, productIds, { quantity = 1, selected = true } = {}) {
    const box = await pool.query(
      'INSERT INTO cart_boxes (user_id, size, quantity, selected) VALUES ($1, $2, $3, $4) RETURNING id',
      [userId, productIds.length, quantity, selected],
    );
    for (let slot = 0; slot < productIds.length; slot += 1) {
      await pool.query(
        'INSERT INTO cart_box_items (box_id, slot, product_id) VALUES ($1, $2, $3)',
        [box.rows[0].id, slot, productIds[slot]],
      );
    }
    return box.rows[0].id;
  }

  async function placeOrder(userId, checkout, clientOverride = null) {
    const client = clientOverride ?? await pool.connect();
    try {
      return await createOrder(client, userId, checkout, orderRequestFingerprint(checkout));
    } finally {
      if (!clientOverride) client.release();
    }
  }

  async function databaseCounts(userId) {
    const result = await pool.query(
      `SELECT
         (SELECT count(*)::int FROM orders WHERE user_id = $1) AS orders,
         (SELECT count(*)::int FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE o.user_id = $1) AS items,
         (SELECT count(*)::int FROM cart_items WHERE user_id = $1) AS cart_items,
         (SELECT count(*)::int FROM cart_boxes WHERE user_id = $1) AS cart_boxes`,
      [userId],
    );
    return result.rows[0];
  }

  async function waitFor(check, message, timeoutMs = 4_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await check()) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(message);
  }

  before(async () => {
    assert.ok(appPool, 'DATABASE_URL must configure the application pool.');
    await initDb();
    await resetFixtures();
  });

  after(async () => {
    await resetFixtures();
    await pool.end();
    await appPool.end();
  });

  describe('real PostgreSQL orders', { concurrency: false }, () => {
    test('applies the migration idempotently with required tables, constraints and indexes', async () => {
      const secondRun = await initDb();
      assert.equal(secondRun.seeded, 0);
      const tables = await pool.query(
        `SELECT tablename FROM pg_tables
         WHERE schemaname = 'public' AND tablename = ANY($1) ORDER BY tablename`,
        [['order_box_items', 'order_items', 'orders']],
      );
      assert.deepEqual(tables.rows.map((row) => row.tablename), ['order_box_items', 'order_items', 'orders']);
      const marker = await pool.query("SELECT value FROM app_meta WHERE key = 'orders_v1'");
      assert.equal(marker.rowCount, 1);
      assert.notEqual(marker.rows[0].value, 'pending');
      const indexes = await pool.query(
        `SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'orders'`,
      );
      const indexNames = new Set(indexes.rows.map((row) => row.indexname));
      assert.ok(indexNames.has('orders_user_created_idx'));
      assert.ok(indexNames.has('orders_user_id_idempotency_key_key'));
      const foreignKeys = await pool.query(
        `SELECT conname, pg_get_constraintdef(oid) AS definition FROM pg_constraint
         WHERE contype = 'f' AND conrelid = ANY($1::regclass[])`,
        [['orders', 'order_items', 'order_box_items']],
      );
      assert.ok(foreignKeys.rows.some((row) => row.definition.includes('users(id) ON DELETE RESTRICT')));
      assert.ok(foreignKeys.rows.filter((row) => row.definition.includes('products(id) ON DELETE SET NULL')).length === 2);
    });

    test('persists exact single pricing, delivery fee, unselected rows and immutable receipts', async () => {
      await resetFixtures();
      const userId = await addUser('single');
      const selectedId = await addProduct({ label: 'selected', price: '120.00', salePrice: '99.99' });
      const unselectedId = await addProduct({ label: 'unselected', price: '75.00' });
      await addSingle(userId, selectedId, { quantity: 3 });
      await addSingle(userId, unselectedId, { selected: false });
      const result = await placeOrder(userId, deliveryCheckout());
      assert.equal(result.order.merchandiseSubtotal, 299.97);
      assert.equal(result.order.promotionDiscount, 60.03);
      assert.equal(result.order.deliveryFee, 49);
      assert.equal(result.order.total, 348.97);
      assert.deepEqual(await databaseCounts(userId), { orders: 1, items: 1, cart_items: 1, cart_boxes: 0 });

      await pool.query("UPDATE products SET name = 'Changed', price = 999.99, sale_price = NULL WHERE id = $1", [selectedId]);
      const client = await pool.connect();
      const receipt = await getOrderByPublicId(client, userId, result.order.id);
      const foreignReceipt = await getOrderByPublicId(client, userId + 10_000, result.order.id);
      client.release();
      assert.equal(receipt.items[0].displayName, 'Integration selected');
      assert.equal(receipt.items[0].unitPrice, 99.99);
      assert.equal(foreignReceipt, null);

      await pool.query('DELETE FROM products WHERE id = $1', [selectedId]);
      const retained = await pool.query(
        'SELECT product_id, display_name FROM order_items WHERE order_id = (SELECT id FROM orders WHERE public_id = $1)',
        [result.order.id],
      );
      assert.deepEqual(retained.rows[0], { product_id: null, display_name: 'Integration selected' });
      await assert.rejects(() => pool.query('DELETE FROM users WHERE id = $1', [userId]), (error) => error.code === '23503');
    });

    test('persists selected boxes, mixed carts, free delivery and pickup', async () => {
      await resetFixtures();
      const userId = await addUser('boxes');
      const products = [];
      for (let index = 0; index < 6; index += 1) {
        products.push(await addProduct({ label: `box-${index}`, price: '100.00' }));
      }
      await addBox(userId, products);
      const boxResult = await placeOrder(userId, deliveryCheckout());
      assert.equal(boxResult.order.merchandiseSubtotal, 540);
      assert.equal(boxResult.order.packDiscount, 60);
      assert.equal(boxResult.order.deliveryFee, 0);
      assert.equal(boxResult.order.items[0].boxItems.length, 6);

      const singleId = await addProduct({ label: 'pickup-single', price: '40.00' });
      const mixedProducts = [];
      for (let index = 0; index < 4; index += 1) {
        mixedProducts.push(await addProduct({ label: `mixed-${index}`, price: '100.00' }));
      }
      await addSingle(userId, singleId, { quantity: 2 });
      await addBox(userId, mixedProducts);
      const pickup = await placeOrder(userId, pickupCheckout());
      assert.equal(pickup.order.merchandiseSubtotal, 460);
      assert.equal(pickup.order.deliveryFee, 0);
      assert.equal(pickup.order.total, 460);
      assert.equal(pickup.order.deliveryAddress, null);
    });

    test('rejects unavailable singles and box components without changing database state', async () => {
      await resetFixtures();
      const userId = await addUser('unavailable');
      const unavailableId = await addProduct({ label: 'unavailable-single', available: false });
      await addSingle(userId, unavailableId);
      await assert.rejects(() => placeOrder(userId, deliveryCheckout()), (error) => error.status === 409);
      assert.deepEqual(await databaseCounts(userId), { orders: 0, items: 0, cart_items: 1, cart_boxes: 0 });

      await pool.query('DELETE FROM cart_items WHERE user_id = $1', [userId]);
      const boxProducts = [];
      for (let index = 0; index < 4; index += 1) {
        boxProducts.push(await addProduct({ label: `unavailable-box-${index}`, available: index !== 2 }));
      }
      await addBox(userId, boxProducts);
      await assert.rejects(() => placeOrder(userId, deliveryCheckout()), (error) => error.status === 409);
      assert.deepEqual(await databaseCounts(userId), { orders: 0, items: 0, cart_items: 0, cart_boxes: 1 });
    });

    test('rolls back header, line, component and cart-clearing failures', async () => {
      for (const failure of ['orders', 'order_items', 'order_box_items', 'DELETE FROM cart_boxes']) {
        await resetFixtures();
        const userId = await addUser(`rollback-${failure.replaceAll(' ', '-')}`);
        const products = [];
        for (let index = 0; index < 4; index += 1) {
          products.push(await addProduct({ label: `rollback-${index}`, price: '100.00' }));
        }
        await addBox(userId, products);
        const client = await pool.connect();
        const wrapped = {
          query(text, params) {
            const sql = String(text).replace(/\s+/g, ' ').trim();
            const shouldFail = failure === 'orders'
              ? sql.startsWith('INSERT INTO orders ')
              : failure === 'order_items'
                ? sql.startsWith('INSERT INTO order_items ')
                : failure === 'order_box_items'
                  ? sql.startsWith('INSERT INTO order_box_items ')
                  : sql.startsWith(failure);
            if (shouldFail) throw new Error(`Injected ${failure} failure`);
            return client.query(text, params);
          },
        };
        await assert.rejects(() => placeOrder(userId, deliveryCheckout(), wrapped));
        client.release();
        assert.deepEqual(await databaseCounts(userId), { orders: 0, items: 0, cart_items: 0, cart_boxes: 1 });
      }
    });

    test('serializes idempotent retries and competing checkout keys', async () => {
      await resetFixtures();
      const userId = await addUser('idempotency');
      const productId = await addProduct({ label: 'idempotency', price: '100.00' });
      await addSingle(userId, productId);
      const checkout = deliveryCheckout();
      const [first, second] = await Promise.all([placeOrder(userId, checkout), placeOrder(userId, checkout)]);
      assert.deepEqual([first.created, second.created].sort(), [false, true]);
      assert.equal(first.order.id, second.order.id);
      assert.equal((await databaseCounts(userId)).orders, 1);

      await addSingle(userId, productId);
      const changed = { ...deliveryCheckout({ idempotencyKey: crypto.randomUUID() }), notes: 'First details' };
      const conflicting = { ...changed, notes: 'Different details' };
      const conflictResults = await Promise.allSettled([
        placeOrder(userId, changed),
        placeOrder(userId, conflicting),
      ]);
      assert.equal(conflictResults.filter((result) => result.status === 'fulfilled').length, 1);
      assert.equal(conflictResults.find((result) => result.status === 'rejected').reason.status, 409);

      await addSingle(userId, productId);
      const competing = await Promise.allSettled([
        placeOrder(userId, deliveryCheckout()),
        placeOrder(userId, deliveryCheckout()),
      ]);
      assert.equal(competing.filter((result) => result.status === 'fulfilled').length, 1);
      assert.equal(competing.find((result) => result.status === 'rejected').reason.status, 409);
    });

    test('allows retry after rollback and replay after a committed response is lost', async () => {
      await resetFixtures();
      const userId = await addUser('retry');
      const productId = await addProduct({ label: 'retry', price: '100.00' });
      await addSingle(userId, productId);
      const checkout = deliveryCheckout();
      const client = await pool.connect();
      const failing = {
        query(text, params) {
          if (String(text).replace(/\s+/g, ' ').trim().startsWith('INSERT INTO order_items ')) {
            throw new Error('Injected lost transaction');
          }
          return client.query(text, params);
        },
      };
      await assert.rejects(() => placeOrder(userId, checkout, failing));
      client.release();
      const created = await placeOrder(userId, checkout);
      const replay = await placeOrder(userId, checkout);
      assert.equal(created.created, true);
      assert.equal(replay.created, false);
      assert.equal(created.order.id, replay.order.id);
    });

    test('uses independent advisory locks for different customers', async () => {
      await resetFixtures();
      const firstUser = await addUser('parallel-a');
      const secondUser = await addUser('parallel-b');
      const firstProduct = await addProduct({ label: 'parallel-a' });
      const secondProduct = await addProduct({ label: 'parallel-b' });
      await addSingle(firstUser, firstProduct);
      await addSingle(secondUser, secondProduct);
      const firstClient = await pool.connect();
      const secondClient = await pool.connect();
      await Promise.all([
        firstClient.query('BEGIN'),
        secondClient.query('BEGIN'),
      ]);
      await Promise.all([
        lockUserCart(firstClient, firstUser),
        lockUserCart(secondClient, secondUser),
      ]);
      await Promise.all([firstClient.query('ROLLBACK'), secondClient.query('ROLLBACK')]);
      firstClient.release();
      secondClient.release();
    });

    test('enforces user-scoped idempotency keys at the database level', async () => {
      await resetFixtures();
      const firstUser = await addUser('key-a');
      const secondUser = await addUser('key-b');
      const firstProduct = await addProduct({ label: 'key-a' });
      const secondProduct = await addProduct({ label: 'key-b' });
      await addSingle(firstUser, firstProduct);
      await addSingle(secondUser, secondProduct);
      const sharedKey = crypto.randomUUID();
      await Promise.all([
        placeOrder(firstUser, deliveryCheckout({ idempotencyKey: sharedKey })),
        placeOrder(secondUser, deliveryCheckout({ idempotencyKey: sharedKey })),
      ]);
      const count = await pool.query('SELECT count(*)::int AS count FROM orders WHERE idempotency_key = $1', [sharedKey]);
      assert.equal(count.rows[0].count, 2);
    });

    test('API validates authentication, authority, replay, ownership and compatible cart locks', async () => {
      await resetFixtures();
      const apiPort = 31_071;
      const apiBase = `http://127.0.0.1:${apiPort}/api`;
      const api = spawn(process.execPath, ['src/index.js'], {
        cwd: new URL('..', import.meta.url),
        env: {
          ...process.env,
          DATABASE_URL: testDatabaseUrl,
          JWT_SECRET: 'p2a-1-1-integration-only-secret',
          PORT: String(apiPort),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let apiLogs = '';
      api.stdout.on('data', (chunk) => { apiLogs += chunk; });
      api.stderr.on('data', (chunk) => { apiLogs += chunk; });
      try {
        await waitFor(async () => {
          try {
            return (await fetch(`${apiBase}/health`)).ok;
          } catch {
            return false;
          }
        }, `API did not start: ${apiLogs}`);

        const signup = async (suffix) => {
          const response = await fetch(`${apiBase}/auth/signup`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              firstName: 'API',
              lastName: 'Tester',
              email: `p2a11-api-${suffix}@example.test`,
              phone: '09171234567',
              password: 'Safe!Cookie9482',
            }),
          });
          assert.equal(response.status, 201);
          return response.json();
        };
        const firstAccount = await signup('one');
        const secondAccount = await signup('two');
        const productId = await addProduct({ label: 'api', price: '99.99' });
        const secondProductId = await addProduct({ label: 'api-new', price: '75.00' });
        const authHeaders = {
          authorization: `Bearer ${firstAccount.token}`,
          'content-type': 'application/json',
        };

        assert.equal((await fetch(`${apiBase}/orders`, { method: 'POST' })).status, 401);
        assert.equal((await fetch(`${apiBase}/orders`, {
          method: 'POST',
          headers: { authorization: 'Bearer invalid', 'content-type': 'application/json' },
          body: '{}',
        })).status, 401);
        const invalidJson = await fetch(`${apiBase}/orders`, {
          method: 'POST', headers: authHeaders, body: '{',
        });
        assert.equal(invalidJson.status, 400);
        assert.deepEqual(await invalidJson.json(), { message: 'Request body must be valid JSON.' });

        const addResponse = await fetch(`${apiBase}/cart`, {
          method: 'POST', headers: authHeaders, body: JSON.stringify({ productId, quantity: 2 }),
        });
        assert.equal(addResponse.status, 201);
        const checkout = deliveryCheckout();
        const invalidPayment = await fetch(`${apiBase}/orders`, {
          method: 'POST',
          headers: authHeaders,
          body: JSON.stringify({ ...checkout, paymentMethod: 'cash_on_pickup' }),
        });
        assert.equal(invalidPayment.status, 400);
        const injectedTotal = await fetch(`${apiBase}/orders`, {
          method: 'POST', headers: authHeaders, body: JSON.stringify({ ...checkout, total: 1 }),
        });
        assert.equal(injectedTotal.status, 400);

        const createdResponse = await fetch(`${apiBase}/orders`, {
          method: 'POST', headers: authHeaders, body: JSON.stringify(checkout),
        });
        assert.equal(createdResponse.status, 201);
        const created = await createdResponse.json();
        assert.equal(created.merchandiseSubtotal, 199.98);
        assert.equal(created.deliveryFee, 49);
        assert.equal(created.total, 248.98);
        const replay = await fetch(`${apiBase}/orders`, {
          method: 'POST', headers: authHeaders, body: JSON.stringify(checkout),
        });
        assert.equal(replay.status, 200);
        assert.equal((await replay.json()).id, created.id);
        const conflict = await fetch(`${apiBase}/orders`, {
          method: 'POST', headers: authHeaders, body: JSON.stringify({ ...checkout, notes: 'Changed' }),
        });
        assert.equal(conflict.status, 409);
        assert.equal((await fetch(`${apiBase}/orders/${created.id}`, { headers: authHeaders })).status, 200);
        assert.equal((await fetch(`${apiBase}/orders/${created.id}`, {
          headers: { authorization: `Bearer ${secondAccount.token}` },
        })).status, 404);

        await fetch(`${apiBase}/cart`, {
          method: 'POST', headers: authHeaders, body: JSON.stringify({ productId, quantity: 1 }),
        });
        await pool.query(
          `CREATE OR REPLACE FUNCTION p2a11_pause_order() RETURNS trigger LANGUAGE plpgsql AS $$
           BEGIN PERFORM pg_sleep(0.6); RETURN NEW; END $$`,
        );
        await pool.query(
          'CREATE TRIGGER p2a11_pause_order BEFORE INSERT ON orders FOR EACH ROW EXECUTE FUNCTION p2a11_pause_order()',
        );
        const delayedCheckout = deliveryCheckout();
        const delayedOrder = fetch(`${apiBase}/orders`, {
          method: 'POST', headers: authHeaders, body: JSON.stringify(delayedCheckout),
        });
        await waitFor(async () => {
          const result = await pool.query(
            "SELECT 1 FROM pg_stat_activity WHERE query LIKE 'INSERT INTO orders%' AND wait_event = 'PgSleep'",
          );
          return result.rowCount > 0;
        }, 'Checkout did not reach the deterministic database pause.');
        const addDuringCheckout = fetch(`${apiBase}/cart`, {
          method: 'POST', headers: authHeaders, body: JSON.stringify({ productId: secondProductId, quantity: 1 }),
        });
        await waitFor(async () => {
          const result = await pool.query(
            "SELECT 1 FROM pg_stat_activity WHERE query LIKE 'SELECT pg_advisory_xact_lock%' AND wait_event_type = 'Lock'",
          );
          return result.rowCount > 0;
        }, 'Cart mutation did not wait on the checkout advisory lock.');
        assert.equal((await delayedOrder).status, 201);
        const addedCartResponse = await addDuringCheckout;
        assert.equal(addedCartResponse.status, 201);
        const addedCart = await addedCartResponse.json();
        assert.deepEqual(addedCart.items.map((item) => item.productId), [secondProductId]);

        await pool.query(
          `CREATE OR REPLACE FUNCTION p2a11_pause_cart() RETURNS trigger LANGUAGE plpgsql AS $$
           BEGIN
             PERFORM pg_sleep(0.6);
             IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
             RETURN NEW;
           END $$`,
        );
        await pool.query(
          'CREATE TRIGGER p2a11_pause_cart BEFORE UPDATE OR DELETE ON cart_items FOR EACH ROW EXECUTE FUNCTION p2a11_pause_cart()',
        );
        const quantityChange = fetch(`${apiBase}/cart/${secondProductId}`, {
          method: 'PATCH', headers: authHeaders, body: JSON.stringify({ quantity: 3 }),
        });
        await waitFor(async () => {
          const result = await pool.query(
            "SELECT 1 FROM pg_stat_activity WHERE query LIKE 'UPDATE cart_items SET quantity%' AND wait_event = 'PgSleep'",
          );
          return result.rowCount > 0;
        }, 'Quantity mutation did not reach the deterministic database pause.');
        const quantityCheckout = fetch(`${apiBase}/orders`, {
          method: 'POST', headers: authHeaders, body: JSON.stringify(deliveryCheckout()),
        });
        await waitFor(async () => {
          const result = await pool.query(
            "SELECT 1 FROM pg_stat_activity WHERE query LIKE 'SELECT pg_advisory_xact_lock%' AND wait_event_type = 'Lock'",
          );
          return result.rowCount > 0;
        }, 'Checkout did not wait for the quantity mutation advisory lock.');
        assert.equal((await quantityChange).status, 200);
        const quantityOrderResponse = await quantityCheckout;
        assert.equal(quantityOrderResponse.status, 201);
        const quantityOrder = await quantityOrderResponse.json();
        assert.equal(quantityOrder.items[0].quantity, 3);

        await fetch(`${apiBase}/cart`, {
          method: 'POST', headers: authHeaders, body: JSON.stringify({ productId: secondProductId, quantity: 1 }),
        });
        const deselection = fetch(`${apiBase}/cart/${secondProductId}`, {
          method: 'PATCH', headers: authHeaders, body: JSON.stringify({ selected: false }),
        });
        await waitFor(async () => {
          const result = await pool.query(
            "SELECT 1 FROM pg_stat_activity WHERE query LIKE 'UPDATE cart_items SET selected%' AND wait_event = 'PgSleep'",
          );
          return result.rowCount > 0;
        }, 'Deselection did not reach the deterministic database pause.');
        const deselectedCheckout = fetch(`${apiBase}/orders`, {
          method: 'POST', headers: authHeaders, body: JSON.stringify(deliveryCheckout()),
        });
        await waitFor(async () => {
          const result = await pool.query(
            "SELECT 1 FROM pg_stat_activity WHERE query LIKE 'SELECT pg_advisory_xact_lock%' AND wait_event_type = 'Lock'",
          );
          return result.rowCount > 0;
        }, 'Checkout did not wait for the deselection advisory lock.');
        assert.equal((await deselection).status, 200);
        assert.equal((await deselectedCheckout).status, 409);

        await pool.query('DROP TRIGGER p2a11_pause_cart ON cart_items');
        await pool.query('DROP FUNCTION p2a11_pause_cart()');
        await fetch(`${apiBase}/cart`, {
          method: 'POST', headers: authHeaders, body: JSON.stringify({ productId, quantity: 1 }),
        });
        await fetch(`${apiBase}/cart`, {
          method: 'POST',
          headers: { authorization: `Bearer ${secondAccount.token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ productId: secondProductId, quantity: 1 }),
        });
        const parallelOrders = [
          fetch(`${apiBase}/orders`, {
            method: 'POST', headers: authHeaders, body: JSON.stringify(deliveryCheckout()),
          }),
          fetch(`${apiBase}/orders`, {
            method: 'POST',
            headers: { authorization: `Bearer ${secondAccount.token}`, 'content-type': 'application/json' },
            body: JSON.stringify(deliveryCheckout()),
          }),
        ];
        await waitFor(async () => {
          const result = await pool.query(
            "SELECT count(*)::int AS count FROM pg_stat_activity WHERE query LIKE 'INSERT INTO orders%' AND wait_event = 'PgSleep'",
          );
          return result.rows[0].count >= 2;
        }, 'Different customers did not reach order persistence concurrently.');
        assert.deepEqual((await Promise.all(parallelOrders)).map((response) => response.status), [201, 201]);
      } finally {
        await pool.query('DROP TRIGGER IF EXISTS p2a11_pause_cart ON cart_items');
        await pool.query('DROP FUNCTION IF EXISTS p2a11_pause_cart()');
        await pool.query('DROP TRIGGER IF EXISTS p2a11_pause_order ON orders');
        await pool.query('DROP FUNCTION IF EXISTS p2a11_pause_order()');
        api.kill('SIGTERM');
        await Promise.race([
          new Promise((resolve) => api.once('exit', resolve)),
          new Promise((resolve) => setTimeout(resolve, 2_000)),
        ]);
      }
    });
  });
}
