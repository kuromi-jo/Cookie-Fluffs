/**
 * @file order-service.test.js
 * @description Transaction orchestration tests with a scripted database client.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createOrder, decodeOrderCursor, getOrderByPublicId, listOrders, safeCookieImagePath } from './order-service.js';

const publicId = '123e4567-e89b-42d3-a456-426614174000';
const fingerprint = 'a'.repeat(64);
const checkout = {
  idempotencyKey: '223e4567-e89b-42d3-a456-426614174000',
  fulfillmentMethod: 'delivery',
  paymentMethod: 'cash_on_delivery',
  schedulingMode: 'asap',
  contactName: 'Sample Customer',
  contactPhone: '+639171234567',
  deliveryAddress: {
    addressLine1: 'House 12, Example Street',
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
};

const headerRow = {
  internalId: 55,
  id: publicId,
  fulfillmentMethod: 'delivery',
  paymentMethod: 'cash_on_delivery',
  paymentStatus: 'pending',
  orderStatus: 'placed',
  schedulingMode: 'asap',
  contactName: 'Sample Customer',
  contactPhone: '+639171234567',
  addressLine1: 'House 12, Example Street',
  addressLine2: null,
  barangay: 'Sample Barangay',
  city: 'Quezon City',
  province: 'Metro Manila',
  postalCode: '1100',
  notes: '',
  merchandiseSubtotal: '570.50',
  promotionDiscount: '50.00',
  packDiscount: '19.50',
  discountTotal: '69.50',
  deliveryFee: '0.00',
  total: '570.50',
  currency: 'PHP',
  createdAt: new Date('2026-10-21T00:00:00Z'),
  agreementVersion: 'draft-2026-10-24-v1',
  agreementAcceptedAt: new Date('2026-10-21T00:00:00Z'),
};

function scriptedClient({ unavailable = false, existingFingerprint = null, failAt = null, emptyCart = false } = {}) {
  const calls = [];
  let itemInsert = 0;
  let boxComponentInsert = 0;
  const client = {
    calls,
    async query(text, params = []) {
      const sql = text.replace(/\s+/g, ' ').trim();
      calls.push({ sql, params });
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK' || sql.startsWith('SELECT pg_advisory')) {
        return { rowCount: 0, rows: [] };
      }
      if (sql.startsWith('SELECT id, request_fingerprint')) {
        return existingFingerprint === null
          ? { rowCount: 0, rows: [] }
          : { rowCount: 1, rows: [{ id: 55, requestFingerprint: existingFingerprint }] };
      }
      if (sql.startsWith('SELECT product_id') && sql.includes('FROM cart_items')) {
        return emptyCart ? { rowCount: 0, rows: [] } : { rowCount: 1, rows: [{ productId: 1, quantity: 2 }] };
      }
      if (sql.startsWith('SELECT id, size') && sql.includes('FROM cart_boxes')) {
        return emptyCart ? { rowCount: 0, rows: [] } : { rowCount: 1, rows: [{ id: 10, size: 4, quantity: 1 }] };
      }
      if (sql.includes('FROM cart_box_items')) {
        return {
          rowCount: 4,
          rows: [2, 3, 4, 5].map((productId, slot) => ({ boxId: 10, slot, productId })),
        };
      }
      if (sql.includes('FROM products WHERE id = ANY')) {
        return {
          rowCount: 5,
          rows: [
            { id: 1, name: 'Single Cookie', price: '120.00', salePrice: '100.00', imageUrl: 'assets/cookies/single-cookie.webp', isAvailable: true },
            { id: 2, name: 'Box Cookie A', price: '100.00', salePrice: '90.00', imageUrl: 'assets/cookies/box-a.webp', isAvailable: !unavailable },
            { id: 3, name: 'Box Cookie B', price: '100.00', salePrice: null, imageUrl: 'https://unsafe.example/cookie.webp', isAvailable: true },
            { id: 4, name: 'Box Cookie C', price: '100.00', salePrice: null, imageUrl: 'assets/cookies/../secret.webp', isAvailable: true },
            { id: 5, name: 'Box Cookie D', price: '100.00', salePrice: null, imageUrl: 'assets/cookies/box-d.webp', isAvailable: true },
          ],
        };
      }
      if (sql.startsWith('INSERT INTO orders')) {
        if (failAt === 'header') throw new Error('header failed');
        return { rowCount: 1, rows: [{ id: 55 }] };
      }
      if (sql.startsWith('INSERT INTO order_status_events')) return { rowCount: 1, rows: [] };
      if (sql.startsWith('INSERT INTO order_items')) {
        if (failAt === 'item') throw new Error('item failed');
        return { rowCount: 1, rows: [{ id: 100 + itemInsert++ }] };
      }
      if (sql.startsWith('INSERT INTO order_box_items')) {
        if (failAt === 'component' && boxComponentInsert++ === 0) throw new Error('component failed');
        return { rowCount: 1, rows: [] };
      }
      if (sql.startsWith('DELETE FROM cart_')) {
        if (failAt === 'clearing') throw new Error('clearing failed');
        return { rowCount: 1, rows: [] };
      }
      if (sql.startsWith('SELECT id AS "internalId"')) return { rowCount: 1, rows: [{ ...headerRow }] };
      if (sql.includes('FROM order_items')) {
        return {
          rowCount: 2,
          rows: [
            { id: 100, linePosition: 0, lineType: 'single', productId: 1, displayName: 'Single Cookie', imageUrl: 'assets/cookies/single-cookie.webp', quantity: 2, packSize: null, regularUnitPrice: '120.00', unitPrice: '100.00', promotionDiscount: '40.00', packDiscount: '0.00', lineTotal: '200.00' },
            { id: 101, linePosition: 1, lineType: 'box', productId: null, displayName: 'Box of 4', imageUrl: null, quantity: 1, packSize: 4, regularUnitPrice: '400.00', unitPrice: '370.50', promotionDiscount: '10.00', packDiscount: '19.50', lineTotal: '370.50' },
          ],
        };
      }
      if (sql.includes('FROM order_box_items')) {
        return {
          rowCount: 4,
          rows: [2, 3, 4, 5].map((productId, slot) => ({
            orderItemId: 101,
            slot,
            productId,
            productName: `Box Cookie ${slot + 1}`,
            imageUrl: slot === 0 ? 'assets/cookies/box-a.webp' : null,
            regularPrice: '100.00',
            unitPrice: slot === 0 ? '90.00' : '100.00',
          })),
        };
      }
      if (sql.includes('FROM order_status_events')) {
        return { rowCount: 1, rows: [{ id: crypto.randomUUID(), fromStatus: null, toStatus: 'placed', actorType: 'customer', createdAt: headerRow.createdAt }] };
      }
      if (sql.includes('FROM order_cancellation_requests')) return { rowCount: 0, rows: [] };
      if (sql.includes('FROM order_refunds')) return { rowCount: 0, rows: [] };
      if (sql.includes('FROM refund_events')) return { rowCount: 0, rows: [] };
      // Notification side effect (savepoint-wrapped, preference-gated, deduped insert).
      if (sql.startsWith('SAVEPOINT') || sql.startsWith('RELEASE') || sql.startsWith('ROLLBACK TO SAVEPOINT')) {
        return { rowCount: 0, rows: [] };
      }
      if (sql.includes('notify_order_updates AS "allowed"')) return { rowCount: 1, rows: [{ allowed: true }] };
      if (sql.startsWith('INSERT INTO notifications')) return { rowCount: 1, rows: [] };
      throw new Error(`Unexpected query: ${sql}`);
    },
  };
  return client;
}

test('creates one exact mixed order and deletes only its selected cart rows', async () => {
  const client = scriptedClient();
  const result = await createOrder(client, 7, checkout, fingerprint);
  assert.equal(result.created, true);
  assert.equal(result.order.id, publicId);
  assert.equal(result.order.paymentStatus, 'pending');
  assert.equal(result.order.total, 570.5);
  assert.equal(result.order.items[1].boxItems.length, 4);
  assert.equal(result.order.items[0].imageUrl, 'assets/cookies/single-cookie.webp');
  assert.equal(result.order.items[1].boxItems[0].imageUrl, 'assets/cookies/box-a.webp');
  assert.equal(result.order.items[1].boxItems[1].imageUrl, null);
  const itemInserts = client.calls.filter((call) => call.sql.startsWith('INSERT INTO order_items'));
  assert.equal(itemInserts[0].params[5], 'assets/cookies/single-cookie.webp');
  const componentInserts = client.calls.filter((call) => call.sql.startsWith('INSERT INTO order_box_items'));
  assert.equal(componentInserts[0].params[4], 'assets/cookies/box-a.webp');
  assert.equal(componentInserts[1].params[4], null);
  const orderInsert = client.calls.find((call) => call.sql.startsWith('INSERT INTO orders'));
  assert.equal(orderInsert.params[22], '570.50');
  assert.equal(orderInsert.params[26], '0.00');
  assert.equal(orderInsert.params[29], 'draft-2026-10-24-v1');
  assert.ok(client.calls.some((call) => call.sql.includes('DELETE FROM cart_items') && call.sql.includes('selected = true')));
  assert.ok(client.calls.some((call) => call.sql.includes('DELETE FROM cart_boxes') && call.sql.includes('selected = true')));
  assert.equal(client.calls.at(-1).sql, 'COMMIT');
});

test('returns an idempotent replay without reading or clearing the cart', async () => {
  const client = scriptedClient({ existingFingerprint: fingerprint });
  const result = await createOrder(client, 7, checkout, fingerprint);
  assert.equal(result.created, false);
  assert.equal(result.order.id, publicId);
  assert.equal(client.calls.some((call) => call.sql.includes('FROM cart_items')), false);
  assert.equal(client.calls.some((call) => call.sql.startsWith('DELETE FROM cart_')), false);
});

test('rejects an idempotency key reused with different checkout details', async () => {
  const client = scriptedClient({ existingFingerprint: 'b'.repeat(64) });
  await assert.rejects(() => createOrder(client, 7, checkout, fingerprint), (error) => error.status === 409);
  assert.equal(client.calls.at(-1).sql, 'ROLLBACK');
});

test('rolls back when a selected box component is unavailable', async () => {
  const client = scriptedClient({ unavailable: true });
  await assert.rejects(() => createOrder(client, 7, checkout, fingerprint), (error) => error.status === 409);
  assert.equal(client.calls.some((call) => call.sql.startsWith('INSERT INTO orders')), false);
  assert.equal(client.calls.at(-1).sql, 'ROLLBACK');
});

test('rejects an empty selected cart without creating an order', async () => {
  const client = scriptedClient({ emptyCart: true });
  await assert.rejects(() => createOrder(client, 7, checkout, fingerprint), (error) => error.status === 409);
  assert.equal(client.calls.some((call) => call.sql.startsWith('INSERT INTO orders')), false);
  assert.equal(client.calls.at(-1).sql, 'ROLLBACK');
});

for (const failure of ['header', 'item', 'component', 'clearing']) {
  test(`rolls back when ${failure} persistence fails`, async () => {
    const client = scriptedClient({ failAt: failure });
    await assert.rejects(() => createOrder(client, 7, checkout, fingerprint));
    assert.equal(client.calls.at(-1).sql, 'ROLLBACK');
    assert.equal(client.calls.some((call) => call.sql === 'COMMIT'), false);
  });
}

test('scopes confirmation retrieval to the authenticated customer', async () => {
  const client = scriptedClient();
  const order = await getOrderByPublicId(client, 44, publicId);
  assert.equal(order.id, publicId);
  assert.deepEqual(client.calls[0].params, [44, publicId]);
});

test('lists only the requested customer with a stable opaque cursor', async () => {
  const calls = [];
  const client = {
    async query(text, params) {
      calls.push({ text, params });
      if (text.includes('FROM order_items')) {
        return {
          rows: [
            { orderId: 12, orderItemId: 100, linePosition: 0, lineType: 'single', displayName: 'Choco Chip', quantity: 2, packSize: null, imageUrl: 'assets/cookies/choco-chip.webp' },
          ],
        };
      }
      return {
        rows: [
          { internalId: 12, id: publicId, total: '500.00', createdAt: new Date('2026-10-24T02:00:00Z') },
          { internalId: 11, id: '223e4567-e89b-42d3-a456-426614174000', total: '450.00', createdAt: new Date('2026-10-24T01:00:00Z') },
        ],
      };
    },
  };
  const result = await listOrders(client, 44, { limit: 1 });
  assert.equal(calls[0].params[0], 44);
  assert.match(calls[0].text, /ORDER BY created_at DESC, id DESC/);
  assert.equal(result.orders.length, 1);
  assert.equal(result.orders[0].total, 500);
  assert.deepEqual(result.orders[0].itemNames, ['Choco Chip']);
  assert.equal(result.orders[0].itemCount, 2);
  assert.deepEqual(result.orders[0].thumbnailUrls, ['assets/cookies/choco-chip.webp']);
  assert.deepEqual(decodeOrderCursor(result.nextCursor), { createdAt: '2026-10-24T02:00:00.000Z', id: '12' });
  assert.equal(decodeOrderCursor('not-a-valid-cursor'), null);
});

test('accepts only reviewed local cookie image paths', () => {
  assert.equal(safeCookieImagePath('assets/cookies/choco-chip.webp'), 'assets/cookies/choco-chip.webp');
  assert.equal(safeCookieImagePath('https://example.com/cookie.webp'), null);
  assert.equal(safeCookieImagePath('assets/cookies/../secret.webp'), null);
  assert.equal(safeCookieImagePath('/assets/cookies/choco-chip.webp'), null);
  assert.equal(safeCookieImagePath('assets/profile/avatar.webp'), null);
});
