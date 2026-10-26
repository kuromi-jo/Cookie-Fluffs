/**
 * @file order-integration.test.js
 * @description Opt-in real PostgreSQL migration, order transaction and concurrency tests.
 */
import test, { after, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import pg from 'pg';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const databaseUrl = process.env.DATABASE_URL;

if (!testDatabaseUrl) {
  test('real PostgreSQL order integration', { skip: 'Set TEST_DATABASE_URL to an isolated loopback database.' }, () => {});
} else {
  const parsedUrl = new URL(testDatabaseUrl);
  if (!['localhost', '127.0.0.1', '[::1]'].includes(parsedUrl.hostname) || databaseUrl !== testDatabaseUrl) {
    throw new Error('Integration tests require matching DATABASE_URL and TEST_DATABASE_URL on a loopback host.');
  }
  if (!/(?:test|sandbox)/i.test(parsedUrl.pathname.slice(1)) || ['postgres', 'template0', 'template1'].includes(parsedUrl.pathname.slice(1))) {
    throw new Error('Integration tests require an explicitly named local test or sandbox database.');
  }

  const { Pool } = pg;
  const adminUrl = new URL(testDatabaseUrl);
  adminUrl.pathname = '/postgres';
  adminUrl.search = '';
  const temporaryDatabaseName = `cookie_fluffs_it_${process.pid}_${crypto.randomBytes(6).toString('hex')}`;
  const temporaryDatabaseUrl = new URL(testDatabaseUrl);
  temporaryDatabaseUrl.pathname = `/${temporaryDatabaseName}`;
  const quotedTemporaryDatabase = `"${temporaryDatabaseName.replaceAll('"', '""')}"`;
  const adminPool = new Pool({ connectionString: adminUrl.toString(), ssl: false, max: 1 });
  let pool;
  let appPool;
  let temporaryDatabaseCreated = false;
  let initDb;
  let lockUserCart;
  let createOrder;
  let getOrderByPublicId;
  let listOrders;
  let orderRequestFingerprint;
  let createOrReusePaymentIntent;
  let createOrReusePaymentSession;
  let parsePaymongoEvent;
  let reconcilePaymongoEvent;
  let processDemoCard;
  let processDemoWallet;
  let advanceOrderStatus;
  let createOrderOperator;
  let requestOrderCancellation;
  let resolveCancellationRequest;
  let reviewOrderRefund;
  let revokeOrderOperator;
  let rotateOrderOperatorCredential;
  let reorderOrder;
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
      regionCode: '1300000000',
      region: 'National Capital Region (NCR)',
      barangayCode: '1381300001',
      barangay: 'Alicia',
      cityCode: '1381300000',
      city: 'Quezon City',
      province: 'Metro Manila',
      postalCode: '1100',
    },
    notes: '',
    agreementAccepted: true,
    agreementVersion: 'draft-2026-10-24-v1',
    ...overrides,
  });

  const pickupCheckout = (overrides = {}) => deliveryCheckout({
    fulfillmentMethod: 'pickup',
    paymentMethod: 'cash_on_pickup',
    deliveryAddress: null,
    ...overrides,
  });

  async function resetFixtures() {
    await pool.query('DELETE FROM order_reorder_attempts');
    await pool.query('DELETE FROM payment_webhook_events');
    await pool.query('DELETE FROM refund_events');
    await pool.query('DELETE FROM refund_attempts');
    await pool.query('DELETE FROM order_refunds');
    await pool.query('DELETE FROM payment_attempts');
    await pool.query('DELETE FROM demo_payment_attempts');
    await pool.query('DELETE FROM wallet_demo_attempts');
    await pool.query('DELETE FROM order_cancellation_requests');
    await pool.query('DELETE FROM order_status_events');
    await pool.query('DELETE FROM orders');
    await pool.query('DELETE FROM cart_items');
    await pool.query('DELETE FROM cart_boxes');
    await pool.query("DELETE FROM users WHERE email LIKE 'p2a11-%@example.test'");
    await pool.query("DELETE FROM products WHERE slug LIKE 'p2a11-%'");
    await pool.query('DELETE FROM order_operators');
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

  async function addProduct({ label = 'cookie', price = '100.00', salePrice = null, available = true, imageUrl = null } = {}) {
    fixtureNumber += 1;
    const result = await pool.query(
      `INSERT INTO products
         (slug, name, tagline, description, flavor_notes, category, price, sale_price, image_url, is_available)
       VALUES ($1, $2, 'Test tagline', 'Test description', 'Test notes', 'Classic', $3, $4, $5, $6)
       RETURNING id`,
      [`p2a11-${fixtureNumber}-${label}`, `Integration ${label}`, price, salePrice,
        imageUrl ?? `assets/cookies/integration-${fixtureNumber}.webp`, available],
    );
    return result.rows[0].id;
  }

  async function addOperator(label = 'Baker', options = {}) {
    const credential = `integration-${crypto.randomBytes(32).toString('hex')}`;
    const client = await pool.connect();
    try {
      const operator = await createOrderOperator(client, label, credential, options);
      return { id: operator.id, credential };
    } finally {
      client.release();
    }
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
    const identity = await adminPool.query(
      'SELECT current_database() AS database, host(inet_server_addr()) AS address, inet_server_port() AS port',
    );
    assert.equal(identity.rows[0].database, 'postgres');
    assert.ok(['127.0.0.1', '::1'].includes(identity.rows[0].address));
    assert.equal(identity.rows[0].port, Number(parsedUrl.port || 5432));
    const existing = await adminPool.query('SELECT 1 FROM pg_database WHERE datname = $1', [temporaryDatabaseName]);
    assert.equal(existing.rowCount, 0, 'Refusing to reuse an existing integration database.');
    await adminPool.query(`CREATE DATABASE ${quotedTemporaryDatabase} TEMPLATE template0`);
    temporaryDatabaseCreated = true;

    process.env.DATABASE_URL = temporaryDatabaseUrl.toString();
    process.env.TEST_DATABASE_URL = temporaryDatabaseUrl.toString();
    ({ initDb, pool: appPool } = await import('./db.js'));
    ({ lockUserCart } = await import('./cart-lock.js'));
    ({ createOrder, getOrderByPublicId, listOrders } = await import('./order-service.js'));
    ({ reorderOrder } = await import('./reorder-service.js'));
    ({ orderRequestFingerprint } = await import('./order-validation.js'));
    ({ createOrReusePaymentIntent, createOrReusePaymentSession } = await import('./payment-service.js'));
    ({ parsePaymongoEvent, reconcilePaymongoEvent } = await import('./payment-webhook.js'));
    ({ processDemoCard } = await import('./demo-payment-service.js'));
    ({ processDemoWallet } = await import('./wallet-demo-service.js'));
    ({
      advanceOrderStatus,
      createOrderOperator,
      requestOrderCancellation,
      resolveCancellationRequest,
      reviewOrderRefund,
      revokeOrderOperator,
      rotateOrderOperatorCredential,
    } = await import('./order-lifecycle.js'));
    pool = new Pool({ connectionString: temporaryDatabaseUrl.toString(), ssl: false, max: 20 });
    assert.ok(appPool, 'DATABASE_URL must configure the application pool.');
    await initDb();
    await resetFixtures();
  });

  after(async () => {
    if (pool) await pool.end();
    if (appPool) await appPool.end();
    if (temporaryDatabaseCreated) {
      await adminPool.query(
        'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()',
        [temporaryDatabaseName],
      );
      await adminPool.query(`DROP DATABASE ${quotedTemporaryDatabase}`);
    }
    await adminPool.end();
  });

  describe('real PostgreSQL orders', { concurrency: false }, () => {
    test('applies the migration idempotently with required tables, constraints and indexes', async () => {
      const secondRun = await initDb();
      assert.equal(secondRun.seeded, 0);
      const tables = await pool.query(
        `SELECT tablename FROM pg_tables
         WHERE schemaname = 'public' AND tablename = ANY($1) ORDER BY tablename`,
        [['demo_payment_attempts', 'order_box_items', 'order_items', 'order_operators', 'order_status_events', 'order_cancellation_requests', 'order_refunds', 'order_reorder_attempts', 'orders', 'payment_attempts', 'payment_webhook_events', 'refund_attempts', 'refund_events', 'wallet_demo_attempts']],
      );
      assert.deepEqual(tables.rows.map((row) => row.tablename), [
        'demo_payment_attempts',
        'order_box_items',
        'order_cancellation_requests',
        'order_items',
        'order_operators',
        'order_refunds',
        'order_reorder_attempts',
        'order_status_events',
        'orders',
        'payment_attempts',
        'payment_webhook_events',
        'refund_attempts',
        'refund_events',
        'wallet_demo_attempts',
      ]);
      const marker = await pool.query("SELECT value FROM app_meta WHERE key = 'orders_v1'");
      assert.equal(marker.rowCount, 1);
      assert.notEqual(marker.rows[0].value, 'pending');
      const upgradeMarker = await pool.query("SELECT value FROM app_meta WHERE key = 'checkout_upgrade_v1'");
      assert.equal(upgradeMarker.rowCount, 1);
      assert.notEqual(upgradeMarker.rows[0].value, 'pending');
      const demoMarker = await pool.query("SELECT value FROM app_meta WHERE key = 'card_demo_v1'");
      assert.equal(demoMarker.rowCount, 1);
      assert.notEqual(demoMarker.rows[0].value, 'pending');
      const reorderMarker = await pool.query("SELECT value FROM app_meta WHERE key = 'reorder_v1'");
      assert.equal(reorderMarker.rowCount, 1);
      assert.notEqual(reorderMarker.rows[0].value, 'pending');
      const agreementMarker = await pool.query("SELECT value FROM app_meta WHERE key = 'order_agreement_v1'");
      assert.equal(agreementMarker.rowCount, 1);
      assert.notEqual(agreementMarker.rows[0].value, 'pending');
      const agreementColumns = await pool.query(
        `SELECT column_name FROM information_schema.columns
         WHERE table_name = 'orders' AND column_name = ANY($1) ORDER BY column_name`,
        [['order_agreement_accepted_at', 'order_agreement_version']],
      );
      assert.deepEqual(agreementColumns.rows.map((row) => row.column_name), [
        'order_agreement_accepted_at',
        'order_agreement_version',
      ]);
      const imageMarker = await pool.query("SELECT value FROM app_meta WHERE key = 'order_image_snapshot_v1'");
      assert.equal(imageMarker.rowCount, 1);
      assert.notEqual(imageMarker.rows[0].value, 'pending');
      const lifecycleMarker = await pool.query("SELECT value FROM app_meta WHERE key = 'order_lifecycle_v1'");
      assert.equal(lifecycleMarker.rowCount, 1);
      assert.notEqual(lifecycleMarker.rows[0].value, 'pending');
      const refundMarker = await pool.query("SELECT value FROM app_meta WHERE key = 'refund_management_v1'");
      assert.equal(refundMarker.rowCount, 1);
      assert.notEqual(refundMarker.rows[0].value, 'pending');
      const refundPermission = await pool.query(
        `SELECT column_name FROM information_schema.columns
         WHERE table_name = 'order_operators' AND column_name = 'can_manage_refunds'`,
      );
      assert.equal(refundPermission.rowCount, 1);
      const imageColumns = await pool.query(
        `SELECT table_name, column_name FROM information_schema.columns
         WHERE table_name = ANY($1) AND column_name = 'image_url' ORDER BY table_name`,
        [['order_box_items', 'order_items']],
      );
      assert.deepEqual(imageColumns.rows, [
        { table_name: 'order_box_items', column_name: 'image_url' },
        { table_name: 'order_items', column_name: 'image_url' },
      ]);
      const indexes = await pool.query(
        `SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'orders'`,
      );
      const indexNames = new Set(indexes.rows.map((row) => row.indexname));
      assert.ok(indexNames.has('orders_user_created_idx'));
      assert.ok(indexNames.has('orders_user_id_idempotency_key_key'));
      const paymentIndexes = await pool.query(
        `SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'payment_attempts'`,
      );
      const paymentIndexNames = new Set(paymentIndexes.rows.map((row) => row.indexname));
      assert.ok(paymentIndexNames.has('payment_attempts_one_open_per_order_idx'));
      assert.ok(paymentIndexNames.has('payment_attempts_one_paid_per_order_idx'));
      const paymentColumns = await pool.query(
        `SELECT column_name FROM information_schema.columns
         WHERE table_name = 'payment_attempts' AND column_name = ANY($1) ORDER BY column_name`,
        [['flow_type', 'provider_intent_id']],
      );
      assert.deepEqual(paymentColumns.rows.map((row) => row.column_name), ['flow_type', 'provider_intent_id']);
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
      assert.equal(result.order.agreementVersion, 'draft-2026-10-24-v1');
      assert.ok(result.order.agreementAcceptedAt instanceof Date);
      assert.match(result.order.items[0].imageUrl, /^assets\/cookies\//);
      assert.deepEqual(await databaseCounts(userId), { orders: 1, items: 1, cart_items: 1, cart_boxes: 0 });

      await pool.query(
        'UPDATE orders SET payment_method_v2 = NULL, payment_state = NULL WHERE public_id = $1',
        [result.order.id],
      );
      const historicalClient = await pool.connect();
      const historical = await getOrderByPublicId(historicalClient, userId, result.order.id);
      historicalClient.release();
      assert.equal(historical.paymentMethod, 'cash_on_delivery');
      assert.equal(historical.paymentStatus, 'pending');

      const originalImage = result.order.items[0].imageUrl;
      await pool.query(
        "UPDATE products SET name = 'Changed', price = 999.99, sale_price = NULL, image_url = 'assets/cookies/current-catalog.webp' WHERE id = $1",
        [selectedId],
      );
      const client = await pool.connect();
      const receipt = await getOrderByPublicId(client, userId, result.order.id);
      const foreignReceipt = await getOrderByPublicId(client, userId + 10_000, result.order.id);
      client.release();
      assert.equal(receipt.items[0].displayName, 'Integration selected');
      assert.equal(receipt.items[0].unitPrice, 99.99);
      assert.equal(receipt.items[0].imageUrl, originalImage);
      assert.equal(foreignReceipt, null);

      await pool.query(
        'UPDATE order_items SET image_url = NULL WHERE order_id = (SELECT id FROM orders WHERE public_id = $1)',
        [result.order.id],
      );
      const legacyClient = await pool.connect();
      const legacyReceipt = await getOrderByPublicId(legacyClient, userId, result.order.id);
      legacyClient.release();
      assert.equal(legacyReceipt.items[0].imageUrl, 'assets/cookies/current-catalog.webp');

      await pool.query('DELETE FROM products WHERE id = $1', [selectedId]);
      const retained = await pool.query(
        'SELECT product_id, display_name FROM order_items WHERE order_id = (SELECT id FROM orders WHERE public_id = $1)',
        [result.order.id],
      );
      assert.deepEqual(retained.rows[0], { product_id: null, display_name: 'Integration selected' });
      const missingClient = await pool.connect();
      const missingReceipt = await getOrderByPublicId(missingClient, userId, result.order.id);
      missingClient.release();
      assert.equal(missingReceipt.items[0].imageUrl, null);
      await assert.rejects(() => pool.query('DELETE FROM users WHERE id = $1', [userId]), (error) => error.code === '23503');
    });

    test('stores only real lifecycle events and leaves historical event history limited', async () => {
      await resetFixtures();
      const userId = await addUser('lifecycle-history');
      const productId = await addProduct({ label: 'lifecycle-history' });
      await addSingle(userId, productId);
      const placed = await placeOrder(userId, deliveryCheckout());
      assert.equal(placed.order.historyAvailable, true);
      assert.deepEqual(placed.order.events.map((event) => event.toStatus), ['placed']);

      await pool.query(
        'DELETE FROM order_status_events WHERE order_id = (SELECT id FROM orders WHERE public_id = $1)',
        [placed.order.id],
      );
      const client = await pool.connect();
      try {
        const historical = await getOrderByPublicId(client, userId, placed.order.id);
        assert.equal(historical.orderStatus, 'placed');
        assert.equal(historical.historyAvailable, false);
        assert.deepEqual(historical.events, []);
      } finally {
        client.release();
      }
    });

    test('rotates and revokes individually hashed operator credentials', async () => {
      await resetFixtures();
      const operator = await addOperator('Credential Baker');
      const replacement = `replacement-${crypto.randomBytes(32).toString('hex')}`;
      const client = await pool.connect();
      try {
        const rotated = await rotateOrderOperatorCredential(client, operator.id, operator.credential, replacement);
        assert.equal(rotated.credentialVersion, 2);
        const stored = await client.query(
          'SELECT credential_hash, revoked_at FROM order_operators WHERE public_id = $1',
          [operator.id],
        );
        assert.equal(stored.rows[0].credential_hash.includes(operator.credential), false);
        assert.equal(stored.rows[0].credential_hash.includes(replacement), false);
        await assert.rejects(
          () => revokeOrderOperator(client, operator.id, operator.credential),
          (error) => error.status === 401,
        );
        const revoked = await revokeOrderOperator(client, operator.id, replacement);
        assert.ok(revoked.revokedAt instanceof Date);
        await assert.rejects(
          () => rotateOrderOperatorCredential(client, operator.id, replacement, operator.credential),
          (error) => error.status === 401,
        );
      } finally {
        client.release();
      }
    });

    test('cancels placed and confirmed orders idempotently without changing paid state', async () => {
      await resetFixtures();
      const userId = await addUser('cancel-immediate');
      const productId = await addProduct({ label: 'cancel-immediate' });
      await addSingle(userId, productId);
      const placed = await placeOrder(userId, deliveryCheckout({ paymentMethod: 'gcash' }));
      const paidAttempt = await pool.query(
        `INSERT INTO payment_attempts
           (public_id, order_id, provider, payment_method, provider_method, idempotency_key,
            provider_payment_id, amount_centavos, currency, status, flow_type)
         SELECT $2, id, 'paymongo', 'gcash', 'gcash', $3, $4,
                round(order_total * 100)::bigint, currency, 'paid', 'payment_intent'
         FROM orders WHERE public_id = $1 RETURNING id`,
        [placed.order.id, crypto.randomUUID(), crypto.randomUUID(), `pay_cancel_${crypto.randomBytes(8).toString('hex')}`],
      );
      assert.equal(paidAttempt.rowCount, 1);
      await pool.query('UPDATE orders SET payment_state = $2 WHERE public_id = $1', [placed.order.id, 'paid']);
      const foreignUserId = await addUser('cancel-foreign');
      const foreignClient = await pool.connect();
      try {
        await assert.rejects(
          () => requestOrderCancellation(foreignClient, foreignUserId, placed.order.id, crypto.randomUUID()),
          (error) => error.status === 404,
        );
      } finally {
        foreignClient.release();
      }
      const cancellationKey = crypto.randomUUID();
      const firstClient = await pool.connect();
      const secondClient = await pool.connect();
      try {
        const [first, replay] = await Promise.all([
          requestOrderCancellation(firstClient, userId, placed.order.id, cancellationKey),
          requestOrderCancellation(secondClient, userId, placed.order.id, cancellationKey),
        ]);
        assert.equal(first.id, replay.id);
        assert.equal(first.status, 'approved');
        assert.equal(first.refundReviewStatus, 'review_required');
        const order = await getOrderByPublicId(firstClient, userId, placed.order.id);
        assert.equal(order.orderStatus, 'cancelled');
        assert.equal(order.paymentStatus, 'paid');
        assert.equal(order.events.at(-1).toStatus, 'cancelled');
      } finally {
        firstClient.release();
        secondClient.release();
      }
      const counts = await pool.query(
        `SELECT
           (SELECT count(*)::int FROM order_cancellation_requests WHERE order_id = orders.id) AS requests,
           (SELECT count(*)::int FROM order_status_events WHERE order_id = orders.id AND to_status = 'cancelled') AS cancellations,
           (SELECT count(*)::int FROM order_refunds WHERE order_id = orders.id) AS refunds
         FROM orders WHERE public_id = $1`,
        [placed.order.id],
      );
      assert.deepEqual(counts.rows[0], { requests: 1, cancellations: 1, refunds: 1 });

      const refund = await pool.query(
        `SELECT public_id AS id, status, amount_centavos AS amount, currency,
                provider_payment_id AS "providerPaymentId", created_at AS "createdAt"
         FROM order_refunds WHERE payment_attempt_id = $1`,
        [paidAttempt.rows[0].id],
      );
      const fulfillmentOnly = await addOperator('Fulfillment only');
      const refundOperator = await addOperator('Refund reviewer', { canManageRefunds: true });
      const deniedClient = await pool.connect();
      try {
        await assert.rejects(
          () => reviewOrderRefund(
            deniedClient, fulfillmentOnly, refund.rows[0].id, 'approve', crypto.randomUUID(), 'Approved review.',
          ),
          (error) => error.status === 403,
        );
      } finally {
        deniedClient.release();
      }
      const reviewKey = crypto.randomUUID();
      const reviewClients = await Promise.all([pool.connect(), pool.connect()]);
      try {
        const decisions = await Promise.all(reviewClients.map((client) => reviewOrderRefund(
          client, refundOperator, refund.rows[0].id, 'approve', reviewKey, 'Approved full refund review.',
        )));
        assert.equal(decisions.filter((decision) => decision.replayed).length, 1);
      } finally {
        reviewClients.forEach((client) => client.release());
      }
      const reviewed = await pool.query(
        `SELECT status, amount_centavos AS amount, approved_amount_centavos AS "approvedAmount",
                reviewed_at AS "reviewedAt",
                (SELECT count(*)::int FROM refund_events
                 WHERE refund_id = order_refunds.id AND to_status = 'approved') AS approvals
         FROM order_refunds WHERE public_id = $1`,
        [refund.rows[0].id],
      );
      assert.equal(reviewed.rows[0].status, 'approved');
      assert.equal(reviewed.rows[0].approvedAmount, reviewed.rows[0].amount);
      assert.ok(reviewed.rows[0].reviewedAt instanceof Date);
      assert.equal(reviewed.rows[0].approvals, 1);
      assert.equal((await getOrderByPublicId(pool, userId, placed.order.id)).paymentStatus, 'paid');
    });

    test('serializes preparation against cancellation and requires operator review once preparing', async () => {
      await resetFixtures();
      const userId = await addUser('cancel-race');
      const productId = await addProduct({ label: 'cancel-race' });
      await addSingle(userId, productId);
      const placed = await placeOrder(userId, deliveryCheckout());
      const operator = await addOperator('Race Baker');
      const transitionClient = await pool.connect();
      await advanceOrderStatus(transitionClient, operator, placed.order.id, 'confirmed', crypto.randomUUID());
      transitionClient.release();

      const prepareClient = await pool.connect();
      const cancelClient = await pool.connect();
      try {
        const results = await Promise.allSettled([
          advanceOrderStatus(prepareClient, operator, placed.order.id, 'preparing', crypto.randomUUID()),
          requestOrderCancellation(cancelClient, userId, placed.order.id, crypto.randomUUID()),
        ]);
        assert.ok(results.some((result) => result.status === 'fulfilled'));
      } finally {
        prepareClient.release();
        cancelClient.release();
      }
      const state = await pool.query(
        `SELECT orders.order_status,
                (SELECT status FROM order_cancellation_requests WHERE order_id = orders.id ORDER BY id DESC LIMIT 1) AS cancellation_status
         FROM orders WHERE public_id = $1`,
        [placed.order.id],
      );
      assert.ok(
        (state.rows[0].order_status === 'cancelled' && state.rows[0].cancellation_status === 'approved')
        || (state.rows[0].order_status === 'preparing' && state.rows[0].cancellation_status === 'pending'),
      );
    });

    test('opens refund review when a cancelled wallet order settles later', async () => {
      await resetFixtures();
      const userId = await addUser('late-refund');
      const productId = await addProduct({ label: 'late-refund', price: '151.00' });
      await addSingle(userId, productId);
      const placed = await placeOrder(userId, deliveryCheckout({ paymentMethod: 'gcash' }));
      const paymentIntentId = `pi_late_${crypto.randomBytes(8).toString('hex')}`;
      await pool.query(
        `INSERT INTO payment_attempts
           (public_id, order_id, provider, payment_method, provider_method, idempotency_key,
            provider_intent_id, amount_centavos, currency, status, flow_type)
         SELECT $2, id, 'paymongo', 'gcash', 'gcash', $3, $4,
                round(order_total * 100)::bigint, currency, 'active', 'payment_intent'
         FROM orders WHERE public_id = $1`,
        [placed.order.id, crypto.randomUUID(), crypto.randomUUID(), paymentIntentId],
      );
      const cancellationClient = await pool.connect();
      try {
        const cancellation = await requestOrderCancellation(
          cancellationClient, userId, placed.order.id, crypto.randomUUID(),
        );
        assert.equal(cancellation.status, 'approved');
        assert.equal(cancellation.refundReviewStatus, 'not_required');
      } finally {
        cancellationClient.release();
      }
      const storedOrder = await pool.query(
        `SELECT round(order_total * 100)::int AS amount FROM orders WHERE public_id = $1`,
        [placed.order.id],
      );
      const providerPaymentId = `pay_late_${crypto.randomBytes(8).toString('hex')}`;
      const payload = {
        data: { id: `evt_late_${crypto.randomBytes(8).toString('hex')}`, type: 'event', attributes: {
          type: 'payment.paid', livemode: false, data: { id: providerPaymentId, attributes: {
            payment_intent_id: paymentIntentId, amount: storedOrder.rows[0].amount,
            currency: 'PHP', status: 'paid', source: { type: 'gcash' },
          } },
        } },
      };
      const raw = Buffer.from(JSON.stringify(payload));
      const webhookClient = await pool.connect();
      try {
        await reconcilePaymongoEvent(
          webhookClient,
          parsePaymongoEvent(payload, raw),
          crypto.createHash('sha256').update(raw).digest('hex'),
        );
      } finally {
        webhookClient.release();
      }
      const state = await pool.query(
        `SELECT o.order_status, o.payment_state,
                r.status AS refund_status, r.provider_payment_id,
                c.refund_review_status
         FROM orders o
         JOIN order_cancellation_requests c ON c.order_id = o.id
         JOIN order_refunds r ON r.order_id = o.id
         WHERE o.public_id = $1`,
        [placed.order.id],
      );
      assert.deepEqual(state.rows[0], {
        order_status: 'cancelled',
        payment_state: 'paid',
        refund_status: 'review_required',
        provider_payment_id: providerPaymentId,
        refund_review_status: 'review_required',
      });
    });

    test('backfills only verified historical paid wallet cancellations once', async () => {
      await resetFixtures();
      const userId = await addUser('refund-backfill');
      const productId = await addProduct({ label: 'refund-backfill', price: '125.00' });
      await addSingle(userId, productId);
      const eligible = await placeOrder(userId, deliveryCheckout({ paymentMethod: 'maya' }));
      const order = await pool.query(
        'SELECT id, round(order_total * 100)::bigint AS amount FROM orders WHERE public_id = $1',
        [eligible.order.id],
      );
      const cancellation = await pool.query(
         `INSERT INTO order_cancellation_requests
           (public_id, order_id, requested_by_user_id, idempotency_key, status,
            refund_review_status, resolved_at)
         VALUES ($1, $2, $3, $4, 'approved', 'not_required', now()) RETURNING id`,
        [crypto.randomUUID(), order.rows[0].id, userId, crypto.randomUUID()],
      );
      assert.equal(cancellation.rowCount, 1);
      await pool.query(
        `INSERT INTO payment_attempts
           (public_id, order_id, provider, payment_method, provider_method, idempotency_key,
            provider_payment_id, amount_centavos, currency, status, flow_type)
         VALUES ($1, $2, 'paymongo', 'maya', 'paymaya', $3, $4, $5, 'PHP', 'paid', 'payment_intent')`,
        [crypto.randomUUID(), order.rows[0].id, crypto.randomUUID(), `pay_backfill_${crypto.randomBytes(8).toString('hex')}`, order.rows[0].amount],
      );
      await pool.query(
        `UPDATE orders SET order_status = 'cancelled', payment_state = 'paid' WHERE id = $1`,
        [order.rows[0].id],
      );
      await pool.query("DELETE FROM app_meta WHERE key = 'refund_management_v1'");
      const migrated = await initDb();
      assert.deepEqual(migrated.refundBackfill, {
        applied: true, reviewed: 1, eligible: 1, created: 1, skipped: 0,
      });
      const replay = await initDb();
      assert.deepEqual(replay.refundBackfill, {
        applied: false, reviewed: 1, eligible: 1, created: 1, skipped: 0,
      });
      const refunds = await pool.query(
        `SELECT count(*)::int AS refunds,
                (SELECT count(*)::int FROM refund_events) AS events,
                (SELECT refund_review_status FROM order_cancellation_requests
                 WHERE id = $2) AS review_status
         FROM order_refunds WHERE order_id = $1`,
        [order.rows[0].id, cancellation.rows[0].id],
      );
      assert.deepEqual(refunds.rows[0], { refunds: 1, events: 1, review_status: 'review_required' });
      const refundRow = await pool.query(
        'SELECT public_id AS id FROM order_refunds WHERE order_id = $1',
        [order.rows[0].id],
      );
      const reviewer = await addOperator('Backfill reviewer', { canManageRefunds: true });
      const reviewClient = await pool.connect();
      try {
        const rejected = await reviewOrderRefund(
          reviewClient,
          reviewer,
          refundRow.rows[0].id,
          'reject',
          crypto.randomUUID(),
          'Refund review was not approved.',
        );
        assert.equal(rejected.status, 'rejected');
      } finally {
        reviewClient.release();
      }
      const rejected = await pool.query(
        `SELECT status, approved_amount_centavos AS "approvedAmount", reviewed_at AS "reviewedAt"
         FROM order_refunds WHERE order_id = $1`,
        [order.rows[0].id],
      );
      assert.equal(rejected.rows[0].status, 'rejected');
      assert.equal(rejected.rows[0].approvedAmount, null);
      assert.ok(rejected.rows[0].reviewedAt instanceof Date);
    });

    test('reviews a preparing cancellation and blocks progress until resolution', async () => {
      await resetFixtures();
      const userId = await addUser('cancel-review');
      const productId = await addProduct({ label: 'cancel-review' });
      await addSingle(userId, productId);
      const placed = await placeOrder(userId, pickupCheckout());
      const operator = await addOperator('Review Baker');
      const client = await pool.connect();
      try {
        await advanceOrderStatus(client, operator, placed.order.id, 'confirmed', crypto.randomUUID());
        await advanceOrderStatus(client, operator, placed.order.id, 'preparing', crypto.randomUUID());
        const request = await requestOrderCancellation(client, userId, placed.order.id, crypto.randomUUID());
        assert.equal(request.status, 'pending');
        await assert.rejects(
          () => advanceOrderStatus(client, operator, placed.order.id, 'ready', crypto.randomUUID()),
          (error) => error.status === 409,
        );
        const resolution = await resolveCancellationRequest(
          client,
          operator,
          request.id,
          'approve',
          crypto.randomUUID(),
        );
        assert.equal(resolution.orderStatus, 'cancelled');
        const order = await getOrderByPublicId(client, userId, placed.order.id);
        assert.equal(order.orderStatus, 'cancelled');
        assert.equal(order.paymentStatus, 'pending_cash');
      } finally {
        client.release();
      }
    });

    test('enforces distinct delivery and pickup transition paths', async () => {
      await resetFixtures();
      const userId = await addUser('transition-paths');
      const productId = await addProduct({ label: 'transition-paths' });
      const operator = await addOperator('Path Baker');
      await addSingle(userId, productId);
      const pickup = await placeOrder(userId, pickupCheckout());
      const client = await pool.connect();
      try {
        await advanceOrderStatus(client, operator, pickup.order.id, 'confirmed', crypto.randomUUID());
        await advanceOrderStatus(client, operator, pickup.order.id, 'preparing', crypto.randomUUID());
        await advanceOrderStatus(client, operator, pickup.order.id, 'ready', crypto.randomUUID());
        await assert.rejects(
          () => advanceOrderStatus(client, operator, pickup.order.id, 'out_for_delivery', crypto.randomUUID()),
          (error) => error.status === 409,
        );
        await advanceOrderStatus(client, operator, pickup.order.id, 'completed', crypto.randomUUID());
        assert.equal((await getOrderByPublicId(client, userId, pickup.order.id)).orderStatus, 'completed');
      } finally {
        client.release();
      }
    });

    test('paginates owned order history without leaking another customer orders', async () => {
      await resetFixtures();
      const userId = await addUser('history');
      const otherUserId = await addUser('history-other');
      const productId = await addProduct({ label: 'history', price: '100.00' });
      await addSingle(userId, productId);
      await placeOrder(userId, deliveryCheckout());
      await addSingle(userId, productId);
      await placeOrder(userId, deliveryCheckout());
      await addSingle(otherUserId, productId);
      await placeOrder(otherUserId, deliveryCheckout());
      const client = await pool.connect();
      try {
        const first = await listOrders(client, userId, { limit: 1 });
        const second = await listOrders(client, userId, { limit: 1, cursor: first.nextCursor });
        assert.equal(first.orders.length, 1);
        assert.equal(second.orders.length, 1);
        assert.notEqual(first.orders[0].id, second.orders[0].id);
        assert.equal(second.nextCursor, null);
        assert.equal([...first.orders, ...second.orders].some((order) => order.id == null), false);
        assert.deepEqual(first.orders[0].itemNames, ['Integration history']);
        assert.equal(first.orders[0].itemCount, 1);
        assert.equal(first.orders[0].thumbnailUrls.length, 1);
      } finally {
        client.release();
      }
    });

    test('reorders available singles at current prices and replays one cart mutation', async () => {
      await resetFixtures();
      const userId = await addUser('reorder-singles');
      const availableId = await addProduct({ label: 'reorder-current', price: '100.00' });
      const unavailableId = await addProduct({ label: 'reorder-missing', price: '80.00' });
      await addSingle(userId, availableId, { quantity: 2 });
      await addSingle(userId, unavailableId, { quantity: 1 });
      const placed = await placeOrder(userId, deliveryCheckout());
      await pool.query('UPDATE products SET price = 125, is_available = true WHERE id = $1', [availableId]);
      await pool.query('UPDATE products SET is_available = false WHERE id = $1', [unavailableId]);
      await addSingle(userId, availableId, { quantity: 3 });
      const key = crypto.randomUUID();
      const client = await pool.connect();
      try {
        const first = await reorderOrder(client, userId, placed.order.id, key);
        assert.equal(first.replayed, false);
        assert.deepEqual(first.added, [{ lineType: 'single', displayName: 'Integration reorder-current', quantity: 2 }]);
        assert.equal(first.unavailable.length, 1);
        assert.equal(first.cart.items[0].quantity, 5);
        assert.equal(first.cart.items[0].price, 125);
        const replay = await reorderOrder(client, userId, placed.order.id, key);
        assert.equal(replay.replayed, true);
        assert.equal(replay.cart.items[0].quantity, 5);
      } finally {
        client.release();
      }
      const attempts = await pool.query('SELECT count(*)::int AS count FROM order_reorder_attempts WHERE user_id = $1', [userId]);
      assert.equal(attempts.rows[0].count, 1);
    });

    test('rebuilds complete boxes and skips the whole box when one component is unavailable', async () => {
      await resetFixtures();
      const userId = await addUser('reorder-box');
      const productIds = [];
      for (let index = 0; index < 4; index += 1) {
        productIds.push(await addProduct({ label: `reorder-box-${index}`, price: '90.00' }));
      }
      await addBox(userId, productIds, { quantity: 2 });
      const placed = await placeOrder(userId, pickupCheckout());
      await pool.query('UPDATE products SET is_available = false WHERE id = $1', [productIds[2]]);
      const client = await pool.connect();
      try {
        const skipped = await reorderOrder(client, userId, placed.order.id, crypto.randomUUID());
        assert.equal(skipped.added.length, 0);
        assert.equal(skipped.unavailable.length, 1);
        assert.equal(skipped.cart.boxes.length, 0);
        await pool.query('UPDATE products SET is_available = true WHERE id = $1', [productIds[2]]);
        const rebuilt = await reorderOrder(client, userId, placed.order.id, crypto.randomUUID());
        assert.equal(rebuilt.added[0].lineType, 'box');
        assert.equal(rebuilt.cart.boxes.length, 1);
        assert.equal(rebuilt.cart.boxes[0].quantity, 2);
        assert.deepEqual(rebuilt.cart.boxes[0].cookies.map((cookie) => cookie.productId), productIds);
      } finally {
        client.release();
      }
    });

    test('serializes concurrent reorder retries and rejects ownership and cross-order key reuse', async () => {
      await resetFixtures();
      const userId = await addUser('reorder-concurrent');
      const otherUserId = await addUser('reorder-other');
      const productId = await addProduct({ label: 'reorder-concurrent', price: '70.00' });
      await addSingle(userId, productId, { quantity: 2 });
      const firstOrder = await placeOrder(userId, pickupCheckout());
      await addSingle(userId, productId, { quantity: 1 });
      const secondOrder = await placeOrder(userId, pickupCheckout());
      const key = crypto.randomUUID();
      const firstClient = await pool.connect();
      const secondClient = await pool.connect();
      try {
        const results = await Promise.all([
          reorderOrder(firstClient, userId, firstOrder.order.id, key),
          reorderOrder(secondClient, userId, firstOrder.order.id, key),
        ]);
        assert.deepEqual(results.map((result) => result.replayed).sort(), [false, true]);
        const cartItem = await pool.query('SELECT quantity FROM cart_items WHERE user_id = $1 AND product_id = $2', [userId, productId]);
        assert.equal(cartItem.rows[0].quantity, 2);
        await assert.rejects(
          () => reorderOrder(firstClient, userId, secondOrder.order.id, key),
          (error) => error.status === 409,
        );
        await assert.rejects(
          () => reorderOrder(firstClient, otherUserId, firstOrder.order.id, crypto.randomUUID()),
          (error) => error.status === 404,
        );
      } finally {
        firstClient.release();
        secondClient.release();
      }
    });

    test('rolls back cart additions when reorder result persistence fails', async () => {
      await resetFixtures();
      const userId = await addUser('reorder-rollback');
      const productId = await addProduct({ label: 'reorder-rollback', price: '60.00' });
      await addSingle(userId, productId, { quantity: 2 });
      const placed = await placeOrder(userId, pickupCheckout());
      const realClient = await pool.connect();
      const failingClient = {
        query(text, params) {
          if (String(text).includes('INSERT INTO order_reorder_attempts')) throw new Error('injected reorder failure');
          return realClient.query(text, params);
        },
      };
      try {
        await assert.rejects(
          () => reorderOrder(failingClient, userId, placed.order.id, crypto.randomUUID()),
          /injected reorder failure/,
        );
      } finally {
        realClient.release();
      }
      const counts = await pool.query(
        `SELECT
           (SELECT count(*)::int FROM cart_items WHERE user_id = $1) AS cart_items,
           (SELECT count(*)::int FROM order_reorder_attempts WHERE user_id = $1) AS attempts`,
        [userId],
      );
      assert.deepEqual(counts.rows[0], { cart_items: 0, attempts: 0 });
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
      assert.ok(boxResult.order.items[0].boxItems.every((item) => item.imageUrl?.startsWith('assets/cookies/')));

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

    test('persists one hosted checkout session and reconciles one paid webhook', async () => {
      await resetFixtures();
      const userId = await addUser('payment');
      const productId = await addProduct({ label: 'payment', price: '139.25' });
      await addSingle(userId, productId);
      const result = await placeOrder(userId, deliveryCheckout({ paymentMethod: 'gcash' }));
      assert.equal(result.order.paymentStatus, 'awaiting_payment');
      const paymentKey = crypto.randomUUID();
      let providerCalls = 0;
      const adapter = {
        async createCheckoutSession() {
          providerCalls += 1;
          return {
            sessionId: 'cs_test_integration',
            checkoutUrl: 'https://checkout.paymongo.com/cs_test_integration',
          };
        },
      };
      const client = await pool.connect();
      try {
        const first = await createOrReusePaymentSession(client, userId, result.order.id, paymentKey, adapter);
        const replay = await createOrReusePaymentSession(client, userId, result.order.id, paymentKey, adapter);
        assert.equal(first.checkoutUrl, 'https://checkout.paymongo.com/cs_test_integration');
        assert.deepEqual(replay, first);
        assert.equal(providerCalls, 1);
        const storedAttempt = await client.query(
          `SELECT amount_centavos::int AS amount, currency, status
           FROM payment_attempts WHERE public_id = $1`,
          [first.attemptId],
        );
        assert.deepEqual(storedAttempt.rows[0], { amount: 18_825, currency: 'PHP', status: 'active' });

        const payload = {
          data: {
            id: 'evt_test_integration',
            type: 'event',
            attributes: {
              type: 'checkout_session.payment.paid',
              livemode: false,
              data: {
                id: 'cs_test_integration',
                attributes: {
                  reference_number: result.order.id,
                  payments: [{
                    id: 'pay_test_integration',
                    attributes: {
                      amount: 18_825,
                      currency: 'PHP',
                      status: 'paid',
                      source: { type: 'gcash' },
                    },
                  }],
                },
              },
            },
          },
        };
        const raw = Buffer.from(JSON.stringify(payload));
        const event = parsePaymongoEvent(payload, raw);
        const hash = crypto.createHash('sha256').update(raw).digest('hex');
        const wrongPayload = structuredClone(payload);
        wrongPayload.data.id = 'evt_test_wrong_amount';
        wrongPayload.data.attributes.data.attributes.payments[0].attributes.amount = 100;
        const wrongRaw = Buffer.from(JSON.stringify(wrongPayload));
        await assert.rejects(() => reconcilePaymongoEvent(
          client,
          parsePaymongoEvent(wrongPayload, wrongRaw),
          crypto.createHash('sha256').update(wrongRaw).digest('hex'),
        ));
        const stillPending = await getOrderByPublicId(client, userId, result.order.id);
        assert.equal(stillPending.paymentStatus, 'awaiting_payment');

        const duplicateClient = await pool.connect();
        try {
          const deliveries = await Promise.all([
            reconcilePaymongoEvent(client, event, hash),
            reconcilePaymongoEvent(duplicateClient, event, hash),
          ]);
          assert.equal(deliveries.filter((entry) => entry.processed).length, 1);
          assert.equal(deliveries.filter((entry) => entry.duplicate).length, 1);
        } finally {
          duplicateClient.release();
        }
        const paid = await getOrderByPublicId(client, userId, result.order.id);
        assert.equal(paid.paymentStatus, 'paid');

        const unknownPayload = structuredClone(payload);
        unknownPayload.data.id = 'evt_test_late_failure';
        unknownPayload.data.attributes.type = 'payment.refunded';
        const unknownRaw = Buffer.from(JSON.stringify(unknownPayload));
        assert.deepEqual(await reconcilePaymongoEvent(
          client,
          parsePaymongoEvent(unknownPayload, unknownRaw),
          crypto.createHash('sha256').update(unknownRaw).digest('hex'),
        ), { duplicate: false, processed: false });
        assert.equal((await getOrderByPublicId(client, userId, result.order.id)).paymentStatus, 'paid');
      } finally {
        client.release();
      }
    });

    test('isolates and serializes idempotent demo-card approval without marking an order paid', async () => {
      await resetFixtures();
      const userId = await addUser('card-demo');
      const productId = await addProduct({ label: 'card-demo', price: '249.00' });
      await addSingle(userId, productId);
      const placed = await placeOrder(userId, deliveryCheckout({ paymentMethod: 'card' }));
      const key = crypto.randomUUID();
      const clients = await Promise.all([pool.connect(), pool.connect()]);
      try {
        const results = await Promise.all(clients.map((client) => processDemoCard(
          client,
          userId,
          placed.order.id,
          key,
          'visa_approved',
          { enabled: true, production: false },
        )));
        assert.deepEqual(results.map((result) => result.attemptId), [results[0].attemptId, results[0].attemptId]);
      } finally {
        clients.forEach((client) => client.release());
      }

      const rows = await pool.query(
        `SELECT d.status, d.amount_centavos, d.currency,
                COALESCE(o.payment_state, o.payment_status) AS payment_status,
                o.payment_is_demo
         FROM demo_payment_attempts d JOIN orders o ON o.id = d.order_id
         WHERE o.public_id = $1`,
        [placed.order.id],
      );
      assert.equal(rows.rowCount, 1);
      assert.deepEqual(rows.rows[0], {
        status: 'demo_approved',
        amount_centavos: '29800',
        currency: 'PHP',
        payment_status: 'awaiting_payment',
        payment_is_demo: true,
      });

      const client = await pool.connect();
      const receipt = await getOrderByPublicId(client, userId, placed.order.id);
      client.release();
      assert.equal(receipt.paymentIsDemo, true);
      assert.equal(receipt.paymentStatus, 'awaiting_payment');
      assert.equal(receipt.demoPayment.status, 'demo_approved');
    });

    test('keeps one order while retrying a declined demo with an approved scenario', async () => {
      await resetFixtures();
      const userId = await addUser('card-demo-retry');
      const productId = await addProduct({ label: 'card-demo-retry', price: '179.00' });
      await addSingle(userId, productId);
      const placed = await placeOrder(userId, deliveryCheckout({ paymentMethod: 'card' }));
      const client = await pool.connect();
      try {
        const declined = await processDemoCard(
          client, userId, placed.order.id, crypto.randomUUID(), 'mastercard_declined',
          { enabled: true, production: false },
        );
        assert.equal(declined.status, 'demo_declined');
        const approved = await processDemoCard(
          client, userId, placed.order.id, crypto.randomUUID(), 'visa_approved',
          { enabled: true, production: false },
        );
        assert.equal(approved.status, 'demo_approved');
      } finally {
        client.release();
      }

      const attempts = await pool.query(
        `SELECT status FROM demo_payment_attempts d
         JOIN orders o ON o.id = d.order_id
         WHERE o.public_id = $1 ORDER BY d.created_at`,
        [placed.order.id],
      );
      assert.deepEqual(attempts.rows.map(({ status }) => status), ['demo_declined', 'demo_approved']);
      const orders = await pool.query(
        `SELECT COUNT(*)::int AS count, MAX(payment_state) AS payment_state
         FROM orders WHERE public_id = $1`,
        [placed.order.id],
      );
      assert.deepEqual(orders.rows[0], { count: 1, payment_state: 'awaiting_payment' });
    });

    test('serializes wallet-demo approval and keeps genuine payment records untouched', async () => {
      await resetFixtures();
      const userId = await addUser('wallet-demo');
      const productId = await addProduct({ label: 'wallet-demo', price: '249.00' });
      await addSingle(userId, productId);
      const checkout = deliveryCheckout({ paymentMethod: 'gcash' });
      const placementClient = await pool.connect();
      let placed;
      try {
        placed = await createOrder(
          placementClient,
          userId,
          checkout,
          orderRequestFingerprint(checkout),
          { paymentIsDemo: true },
        );
      } finally {
        placementClient.release();
      }

      const key = crypto.randomUUID();
      const clients = await Promise.all([pool.connect(), pool.connect()]);
      try {
        const results = await Promise.all(clients.map((client) => processDemoWallet(
          client,
          userId,
          placed.order.id,
          key,
          'confirm',
          { enabled: true, production: false },
        )));
        assert.equal(new Set(results.map((result) => result.attemptId)).size, 1);
      } finally {
        clients.forEach((client) => client.release());
      }

      const state = await pool.query(
        `SELECT w.wallet_method, w.outcome, w.amount_centavos, w.currency,
                o.payment_state, o.payment_is_demo,
                (SELECT count(*)::int FROM payment_attempts p WHERE p.order_id = o.id) AS genuine_attempts
         FROM wallet_demo_attempts w JOIN orders o ON o.id = w.order_id
         WHERE o.public_id = $1`,
        [placed.order.id],
      );
      assert.deepEqual(state.rows[0], {
        wallet_method: 'gcash',
        outcome: 'demo_approved',
        amount_centavos: '29800',
        currency: 'PHP',
        payment_state: 'awaiting_payment',
        payment_is_demo: true,
        genuine_attempts: 0,
      });

      const receiptClient = await pool.connect();
      const receipt = await getOrderByPublicId(receiptClient, userId, placed.order.id);
      receiptClient.release();
      assert.equal(receipt.walletDemoPayment.status, 'demo_approved');
      assert.equal(receipt.paymentStatus, 'awaiting_payment');
    });

    test('keeps one wallet-demo order while retrying after cancellation', async () => {
      await resetFixtures();
      const userId = await addUser('wallet-demo-retry');
      const productId = await addProduct({ label: 'wallet-demo-retry', price: '179.00' });
      await addSingle(userId, productId);
      const checkout = deliveryCheckout({ paymentMethod: 'maya' });
      const placementClient = await pool.connect();
      let placed;
      try {
        placed = await createOrder(
          placementClient, userId, checkout, orderRequestFingerprint(checkout), { paymentIsDemo: true },
        );
      } finally {
        placementClient.release();
      }
      const client = await pool.connect();
      try {
        assert.equal((await processDemoWallet(
          client, userId, placed.order.id, crypto.randomUUID(), 'cancel', { enabled: true },
        )).status, 'demo_cancelled');
        assert.equal((await processDemoWallet(
          client, userId, placed.order.id, crypto.randomUUID(), 'confirm', { enabled: true },
        )).status, 'demo_approved');
      } finally {
        client.release();
      }
      const counts = await pool.query(
        `SELECT count(*)::int AS attempts,
                count(*) FILTER (WHERE outcome = 'demo_approved')::int AS approvals,
                (SELECT count(*)::int FROM orders WHERE public_id = $1) AS orders
         FROM wallet_demo_attempts
         WHERE order_id = (SELECT id FROM orders WHERE public_id = $1)`,
        [placed.order.id],
      );
      assert.deepEqual(counts.rows[0], { attempts: 2, approvals: 1, orders: 1 });
    });

    test('serializes concurrent payment creation and enforces payment ownership', async () => {
      await resetFixtures();
      const userId = await addUser('payment-concurrency');
      const otherUserId = await addUser('payment-foreign');
      const productId = await addProduct({ label: 'payment-concurrency', price: '151.00' });
      await addSingle(userId, productId);
      const result = await placeOrder(userId, deliveryCheckout({ paymentMethod: 'maya' }));
      const paymentKey = crypto.randomUUID();
      const providerKeys = [];
      const adapter = {
        async createCheckoutSession({ idempotencyKey }) {
          providerKeys.push(idempotencyKey);
          await new Promise((resolve) => setTimeout(resolve, 30));
          return {
            sessionId: 'cs_test_concurrent',
            checkoutUrl: 'https://checkout.paymongo.com/cs_test_concurrent',
          };
        },
      };
      const firstClient = await pool.connect();
      const secondClient = await pool.connect();
      try {
        const sessions = await Promise.all([
          createOrReusePaymentSession(firstClient, userId, result.order.id, paymentKey, adapter),
          createOrReusePaymentSession(secondClient, userId, result.order.id, paymentKey, adapter),
        ]);
        assert.equal(new Set(sessions.map((entry) => entry.attemptId)).size, 1);
        assert.equal(new Set(providerKeys).size, 1);
        const attempts = await pool.query(
          `SELECT count(*)::int AS total,
                  count(*) FILTER (WHERE status IN ('creating', 'active', 'processing'))::int AS open
           FROM payment_attempts WHERE order_id = (SELECT id FROM orders WHERE public_id = $1)`,
          [result.order.id],
        );
        assert.deepEqual(attempts.rows[0], { total: 1, open: 1 });
        await assert.rejects(
          () => createOrReusePaymentSession(firstClient, otherUserId, result.order.id, crypto.randomUUID(), adapter),
          (error) => error.status === 404,
        );
      } finally {
        firstClient.release();
        secondClient.release();
      }
    });

    test('persists one Payment Intent across concurrent retries and reconciles it once', async () => {
      await resetFixtures();
      const userId = await addUser('intent-concurrency');
      const productId = await addProduct({ label: 'intent-concurrency', price: '151.00' });
      await addSingle(userId, productId);
      const order = await placeOrder(userId, deliveryCheckout({ paymentMethod: 'gcash' }));
      const paymentKey = crypto.randomUUID();
      const providerKeys = [];
      const adapter = {
        async createPaymentIntent({ idempotencyKey }) {
          providerKeys.push(idempotencyKey);
          await new Promise((resolve) => setTimeout(resolve, 25));
          return { paymentIntentId: 'pi_test_concurrent', clientKey: 'client_test', status: 'awaiting_payment_method' };
        },
        async retrievePaymentIntent(id) {
          return { paymentIntentId: id, clientKey: 'client_test', status: 'awaiting_payment_method' };
        },
      };
      const firstClient = await pool.connect();
      const secondClient = await pool.connect();
      try {
        const attempts = await Promise.all([
          createOrReusePaymentIntent(firstClient, userId, order.order.id, paymentKey, adapter),
          createOrReusePaymentIntent(secondClient, userId, order.order.id, paymentKey, adapter),
        ]);
        assert.equal(new Set(attempts.map((entry) => entry.attemptId)).size, 1);
        assert.equal(new Set(providerKeys).size, 1);
        const paymentEvent = (eventId, eventType = 'payment.paid', paymentId = 'pay_intent_integration') => ({
          data: { id: eventId, type: 'event', attributes: {
            type: eventType, livemode: false, data: { id: paymentId, attributes: {
              payment_intent_id: 'pi_test_concurrent', amount: 20_000, currency: 'PHP',
              status: eventType === 'payment.paid' ? 'paid' : 'failed', source: { type: 'gcash' },
            } },
          } },
        });
        const deliveries = ['evt_intent_integration_a', 'evt_intent_integration_b'].map((eventId) => {
          const payload = paymentEvent(eventId);
          const raw = Buffer.from(JSON.stringify(payload));
          return {
            event: parsePaymongoEvent(payload, raw),
            hash: crypto.createHash('sha256').update(raw).digest('hex'),
          };
        });
        const reconciled = await Promise.all([
          reconcilePaymongoEvent(firstClient, deliveries[0].event, deliveries[0].hash),
          reconcilePaymongoEvent(secondClient, deliveries[1].event, deliveries[1].hash),
        ]);
        assert.equal(reconciled.filter((entry) => entry.processed).length, 2);
        assert.equal(reconciled.filter((entry) => entry.duplicate).length, 0);
        assert.equal((await getOrderByPublicId(firstClient, userId, order.order.id)).paymentStatus, 'paid');

        const settled = await firstClient.query(
          `SELECT o.updated_at AS "orderUpdatedAt", pa.updated_at AS "attemptUpdatedAt",
                  pa.provider_payment_id AS "providerPaymentId", pa.status,
                  count(*) FILTER (WHERE pwe.event_type = 'payment.paid' AND pwe.processed_at IS NOT NULL)::int AS "eventsProcessed"
           FROM orders o
           JOIN payment_attempts pa ON pa.order_id = o.id
           CROSS JOIN payment_webhook_events pwe
           WHERE o.public_id = $1
           GROUP BY o.updated_at, pa.updated_at, pa.provider_payment_id, pa.status`,
          [order.order.id],
        );
        assert.equal(settled.rows[0].providerPaymentId, 'pay_intent_integration');
        assert.equal(settled.rows[0].status, 'paid');
        assert.equal(settled.rows[0].eventsProcessed, 2);

        await firstClient.query('SELECT pg_sleep(0.02)');
        const matchingPayload = paymentEvent('evt_intent_integration_c');
        const matchingRaw = Buffer.from(JSON.stringify(matchingPayload));
        await reconcilePaymongoEvent(
          firstClient,
          parsePaymongoEvent(matchingPayload, matchingRaw),
          crypto.createHash('sha256').update(matchingRaw).digest('hex'),
        );
        const unchanged = await firstClient.query(
          `SELECT o.updated_at AS "orderUpdatedAt", pa.updated_at AS "attemptUpdatedAt"
           FROM orders o JOIN payment_attempts pa ON pa.order_id = o.id WHERE o.public_id = $1`,
          [order.order.id],
        );
        assert.equal(unchanged.rows[0].orderUpdatedAt.getTime(), settled.rows[0].orderUpdatedAt.getTime());
        assert.equal(unchanged.rows[0].attemptUpdatedAt.getTime(), settled.rows[0].attemptUpdatedAt.getTime());

        const conflictingPayload = paymentEvent('evt_intent_conflicting', 'payment.paid', 'pay_intent_conflicting');
        const conflictingRaw = Buffer.from(JSON.stringify(conflictingPayload));
        await assert.rejects(
          () => reconcilePaymongoEvent(
            firstClient,
            parsePaymongoEvent(conflictingPayload, conflictingRaw),
            crypto.createHash('sha256').update(conflictingRaw).digest('hex'),
          ),
          (error) => error.status === 409,
        );
        assert.equal((await firstClient.query(
          `SELECT count(*)::int AS count FROM payment_webhook_events WHERE event_id = 'evt_intent_conflicting'`,
        )).rows[0].count, 0);

        const failedPayload = paymentEvent('evt_intent_late_failure', 'payment.failed');
        const failedRaw = Buffer.from(JSON.stringify(failedPayload));
        await reconcilePaymongoEvent(
          firstClient,
          parsePaymongoEvent(failedPayload, failedRaw),
          crypto.createHash('sha256').update(failedRaw).digest('hex'),
        );
        const afterFailure = await firstClient.query(
          `SELECT o.updated_at AS "orderUpdatedAt", pa.updated_at AS "attemptUpdatedAt",
                  COALESCE(o.payment_state, o.payment_status) AS "paymentStatus", pa.status
           FROM orders o JOIN payment_attempts pa ON pa.order_id = o.id WHERE o.public_id = $1`,
          [order.order.id],
        );
        assert.equal(afterFailure.rows[0].paymentStatus, 'paid');
        assert.equal(afterFailure.rows[0].status, 'paid');
        assert.equal(afterFailure.rows[0].orderUpdatedAt.getTime(), settled.rows[0].orderUpdatedAt.getTime());
        assert.equal(afterFailure.rows[0].attemptUpdatedAt.getTime(), settled.rows[0].attemptUpdatedAt.getTime());
      } finally {
        firstClient.release();
        secondClient.release();
      }
    });

    test('preserves a failed attempt and creates one idempotent replacement under concurrent retry', async () => {
      await resetFixtures();
      const userId = await addUser('failed-payment-retry');
      const productId = await addProduct({ label: 'failed-payment-retry', price: '151.00' });
      await addSingle(userId, productId);
      const order = await placeOrder(userId, deliveryCheckout({ paymentMethod: 'maya' }));
      const firstKey = crypto.randomUUID();
      const client = await pool.connect();
      const secondClient = await pool.connect();
      try {
        await createOrReusePaymentIntent(client, userId, order.order.id, firstKey, {
          async createPaymentIntent() {
            return { paymentIntentId: 'pi_test_failed_retry', clientKey: 'client_failed', status: 'awaiting_payment_method' };
          },
        });
        const failure = (eventId, paymentId = 'pay_test_failed_retry') => ({
          data: { id: eventId, type: 'event', attributes: {
            type: 'payment.failed', livemode: false, data: { id: paymentId, attributes: {
              payment_intent_id: 'pi_test_failed_retry', amount: 20_000, currency: 'PHP',
              status: 'failed', source: { type: 'paymaya' },
            } },
          } },
        });
        const firstFailure = failure('evt_test_failed_retry_a');
        const firstRaw = Buffer.from(JSON.stringify(firstFailure));
        await reconcilePaymongoEvent(
          client,
          parsePaymongoEvent(firstFailure, firstRaw),
          crypto.createHash('sha256').update(firstRaw).digest('hex'),
        );
        const failed = await client.query(
          `SELECT o.updated_at AS "orderUpdatedAt", pa.updated_at AS "attemptUpdatedAt",
                  COALESCE(o.payment_state, o.payment_status) AS "paymentStatus", pa.status,
                  pa.provider_payment_id AS "providerPaymentId"
           FROM orders o JOIN payment_attempts pa ON pa.order_id = o.id
           WHERE o.public_id = $1`,
          [order.order.id],
        );
        assert.equal(failed.rows[0].paymentStatus, 'failed');
        assert.equal(failed.rows[0].status, 'failed');
        assert.equal(failed.rows[0].providerPaymentId, 'pay_test_failed_retry');

        await client.query('SELECT pg_sleep(0.02)');
        const repeatedFailure = failure('evt_test_failed_retry_b');
        const repeatedRaw = Buffer.from(JSON.stringify(repeatedFailure));
        await reconcilePaymongoEvent(
          client,
          parsePaymongoEvent(repeatedFailure, repeatedRaw),
          crypto.createHash('sha256').update(repeatedRaw).digest('hex'),
        );
        const unchanged = await client.query(
          `SELECT o.updated_at AS "orderUpdatedAt", pa.updated_at AS "attemptUpdatedAt"
           FROM orders o JOIN payment_attempts pa ON pa.order_id = o.id
           WHERE o.public_id = $1`,
          [order.order.id],
        );
        assert.equal(unchanged.rows[0].orderUpdatedAt.getTime(), failed.rows[0].orderUpdatedAt.getTime());
        assert.equal(unchanged.rows[0].attemptUpdatedAt.getTime(), failed.rows[0].attemptUpdatedAt.getTime());

        const provider = {
          keys: [],
          failNext: true,
          async retrievePaymentIntent(id) {
            return { paymentIntentId: id, clientKey: 'client_failed', status: 'awaiting_payment_method' };
          },
          async createPaymentIntent({ idempotencyKey }) {
            this.keys.push(idempotencyKey);
            if (this.failNext) {
              this.failNext = false;
              throw new Error('Injected provider timeout');
            }
            await new Promise((resolve) => setTimeout(resolve, 25));
            return { paymentIntentId: 'pi_test_failed_retry_replacement', clientKey: 'client_retry', status: 'awaiting_payment_method' };
          },
        };
        await assert.rejects(
          () => createOrReusePaymentIntent(client, userId, order.order.id, firstKey, provider),
          (error) => error.status === 410 && error.code === 'PAYMENT_ATTEMPT_FAILED',
        );

        const retryKey = crypto.randomUUID();
        await assert.rejects(
          () => createOrReusePaymentIntent(client, userId, order.order.id, retryKey, provider),
          /Injected provider timeout/,
        );
        const retries = await Promise.all([
          createOrReusePaymentIntent(client, userId, order.order.id, retryKey, provider),
          createOrReusePaymentIntent(secondClient, userId, order.order.id, retryKey, provider),
        ]);
        assert.equal(new Set(retries.map((entry) => entry.attemptId)).size, 1);
        assert.equal(new Set(retries.map((entry) => entry.paymentIntentId)).size, 1);
        assert.equal(new Set(provider.keys).size, 1);
        const attempts = await client.query(
          `SELECT status, provider_intent_id AS "providerIntentId", count(*)::int AS count
           FROM payment_attempts
           WHERE order_id = (SELECT id FROM orders WHERE public_id = $1)
           GROUP BY status, provider_intent_id ORDER BY status`,
          [order.order.id],
        );
        assert.deepEqual(attempts.rows, [
          { status: 'active', providerIntentId: 'pi_test_failed_retry_replacement', count: 1 },
          { status: 'failed', providerIntentId: 'pi_test_failed_retry', count: 1 },
        ]);
        assert.equal((await getOrderByPublicId(client, userId, order.order.id)).paymentStatus, 'awaiting_payment');
      } finally {
        client.release();
        secondClient.release();
      }
    });

    test('recovers interrupted creation and rotates only confirmed expired sessions', async () => {
      await resetFixtures();
      const userId = await addUser('payment-recovery');
      const productId = await addProduct({ label: 'payment-recovery', price: '100.00' });
      await addSingle(userId, productId);
      const checkout = deliveryCheckout({ paymentMethod: 'card' });
      const placementClient = await pool.connect();
      let result;
      try {
        result = await createOrder(
          placementClient,
          userId,
          checkout,
          orderRequestFingerprint(checkout),
          { paymentIsDemo: false },
        );
      } finally {
        placementClient.release();
      }
      const firstKey = crypto.randomUUID();
      const client = await pool.connect();
      try {
        await assert.rejects(() => createOrReusePaymentSession(client, userId, result.order.id, firstKey, {
          async createCheckoutSession() { throw new Error('Injected provider timeout'); },
        }));
        const recovered = await createOrReusePaymentSession(client, userId, result.order.id, firstKey, {
          async createCheckoutSession({ idempotencyKey }) {
            assert.equal(idempotencyKey, firstKey);
            return { sessionId: 'cs_test_recovered', checkoutUrl: 'https://checkout.paymongo.com/cs_test_recovered' };
          },
        });
        await client.query("UPDATE payment_attempts SET status = 'expired' WHERE public_id = $1", [recovered.attemptId]);
        await assert.rejects(
          () => createOrReusePaymentSession(client, userId, result.order.id, firstKey, {}),
          (error) => error.status === 410,
        );
        const replacementKey = crypto.randomUUID();
        const replacement = await createOrReusePaymentSession(client, userId, result.order.id, replacementKey, {
          async createCheckoutSession({ idempotencyKey }) {
            assert.equal(idempotencyKey, replacementKey);
            return { sessionId: 'cs_test_replacement', checkoutUrl: 'https://checkout.paymongo.com/cs_test_replacement' };
          },
        });
        assert.notEqual(replacement.attemptId, recovered.attemptId);
        const attempts = await client.query(
          `SELECT status, count(*)::int AS count FROM payment_attempts
           WHERE order_id = (SELECT id FROM orders WHERE public_id = $1)
           GROUP BY status ORDER BY status`,
          [result.order.id],
        );
        assert.deepEqual(attempts.rows, [{ status: 'active', count: 1 }, { status: 'expired', count: 1 }]);
      } finally {
        client.release();
      }
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
          DATABASE_URL: temporaryDatabaseUrl.toString(),
          TEST_DATABASE_URL: temporaryDatabaseUrl.toString(),
          APP_ENV: 'test',
          NODE_ENV: 'test',
          JWT_SECRET: 'p2a-1-1-integration-only-secret-9482',
          PORT: String(apiPort),
          CORS_ALLOWED_ORIGINS: 'https://localhost',
          ORDER_AGREEMENT_REQUIRED: 'true',
          ORDER_AGREEMENT_VERSION: 'draft-2026-10-24-v1',
          CARD_DEMO_ENABLED: 'false',
          WALLET_DEMO_ENABLED: 'false',
          FULFILLMENT_DELIVERY_ENABLED: 'true',
          FULFILLMENT_DELIVERY_CITY_CODES: '1381300000',
          FULFILLMENT_PICKUP_ENABLED: 'true',
          FULFILLMENT_PICKUP_LOCATION: 'Integration test pickup location',
          FULFILLMENT_PICKUP_HOURS: 'Integration test hours',
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

    test('generates a placed notification committed with the order and respects the preference', async () => {
      const userId = await addUser('notify-placed');
      const productId = await addProduct({ label: 'notify-placed' });
      await addSingle(userId, productId);
      const placed = await placeOrder(userId, deliveryCheckout());

      const notes = await pool.query(
        `SELECT event_type AS "eventType", title, link_path AS "linkPath", read_at AS "readAt"
         FROM notifications WHERE user_id = $1 ORDER BY id`,
        [userId],
      );
      assert.equal(notes.rowCount, 1);
      assert.equal(notes.rows[0].eventType, 'order_placed');
      assert.equal(notes.rows[0].linkPath, `/orders/${placed.order.id}`);
      assert.equal(notes.rows[0].readAt, null);

      // With the order preference off, a second placed order creates no order notification.
      await pool.query(
        `INSERT INTO user_preferences (user_id, reduce_motion, larger_text, notify_order_updates)
         VALUES ($1, false, false, false)
         ON CONFLICT (user_id) DO UPDATE SET notify_order_updates = false`,
        [userId],
      );
      await addSingle(userId, productId);
      await placeOrder(userId, deliveryCheckout());
      const afterOptOut = await pool.query('SELECT count(*)::int AS count FROM notifications WHERE user_id = $1', [userId]);
      assert.equal(afterOptOut.rows[0].count, 1);
    });

    test('emits accurate status notifications and dedupes a replayed transition', async () => {
      const userId = await addUser('notify-status');
      const productId = await addProduct({ label: 'notify-status' });
      await addSingle(userId, productId);
      const placed = await placeOrder(userId, pickupCheckout());
      const operator = await addOperator('Notify Baker');
      const key = crypto.randomUUID();
      const client = await pool.connect();
      try {
        await advanceOrderStatus(client, operator, placed.order.id, 'confirmed', key);
        // Replay with the same key must not create a duplicate notification.
        await advanceOrderStatus(client, operator, placed.order.id, 'confirmed', key);
      } finally {
        client.release();
      }
      const confirmed = await pool.query(
        `SELECT count(*)::int AS count FROM notifications
         WHERE user_id = $1 AND event_type = 'order_confirmed'`,
        [userId],
      );
      assert.equal(confirmed.rows[0].count, 1);
    });

    test('still delivers order cancellation when the order preference is off', async () => {
      const userId = await addUser('notify-cancel');
      const productId = await addProduct({ label: 'notify-cancel' });
      await addSingle(userId, productId);
      await pool.query(
        `INSERT INTO user_preferences (user_id, reduce_motion, larger_text, notify_order_updates)
         VALUES ($1, false, false, false) ON CONFLICT (user_id) DO UPDATE SET notify_order_updates = false`,
        [userId],
      );
      const placed = await placeOrder(userId, deliveryCheckout());
      const client = await pool.connect();
      try {
        await requestOrderCancellation(client, userId, placed.order.id, crypto.randomUUID());
      } finally {
        client.release();
      }
      const cancelled = await pool.query(
        `SELECT count(*)::int AS count FROM notifications
         WHERE user_id = $1 AND event_type = 'order_cancelled'`,
        [userId],
      );
      // Placement was suppressed (pref off) but the essential cancellation still arrived.
      assert.equal(cancelled.rows[0].count, 1);
    });

    test('a parent transaction rollback discards the notification (no false notification)', async () => {
      const userId = await addUser('notify-rollback');
      const productId = await addProduct({ label: 'notify-rollback', available: false });
      await addSingle(userId, productId);
      // Placement fails (unavailable product) and rolls back; no notification must remain.
      await assert.rejects(() => placeOrder(userId, deliveryCheckout()), (error) => error.status === 409);
      const notes = await pool.query('SELECT count(*)::int AS count FROM notifications WHERE user_id = $1', [userId]);
      assert.equal(notes.rows[0].count, 0);
    });
  });
}
