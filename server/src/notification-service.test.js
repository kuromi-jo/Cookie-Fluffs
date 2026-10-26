/**
 * @file notification-service.test.js
 * @description Unit tests for notification insertion (preference gating, dedupe, savepoint
 * containment, path validation) and read/list/count query shaping, using a fake PG client.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  insertNotification,
  listNotifications,
  unreadCount,
  markNotificationRead,
  markAllNotificationsRead,
} from './notification-service.js';

// A fake client that records queries and lets a test script responses by matcher.
function fakeClient({ prefRow = { allowed: true }, insertRowCount = 1, failInsert = false } = {}) {
  const calls = [];
  return {
    calls,
    async query(text, params) {
      calls.push({ text: text.trim(), params });
      if (text.startsWith('SAVEPOINT') || text.startsWith('RELEASE') || text.startsWith('ROLLBACK TO SAVEPOINT')) {
        return { rowCount: 0, rows: [] };
      }
      if (text.includes('notify_order_updates AS "allowed"')) {
        return { rowCount: prefRow ? 1 : 0, rows: prefRow ? [prefRow] : [] };
      }
      if (text.startsWith('INSERT INTO notifications')) {
        if (failInsert) throw new Error('simulated insert failure');
        return { rowCount: insertRowCount, rows: [] };
      }
      throw new Error(`Unexpected query: ${text}`);
    },
  };
}

const base = {
  userId: 7,
  eventType: 'order_placed',
  title: 'Order placed',
  body: 'Thanks!',
  linkPath: '/orders/abc',
  dedupeKey: 'order_placed:abc',
  randomUUID: () => '11111111-1111-4111-8111-111111111111',
};

test('inserts an optional order notification when the preference allows it', async () => {
  const client = fakeClient({ prefRow: { allowed: true } });
  const created = await insertNotification(client, base);
  assert.equal(created, true);
  // Wrapped in a savepoint that is released on success.
  assert.ok(client.calls.some((c) => c.text.startsWith('SAVEPOINT')));
  assert.ok(client.calls.some((c) => c.text.startsWith('RELEASE SAVEPOINT')));
  const insert = client.calls.find((c) => c.text.startsWith('INSERT INTO notifications'));
  assert.equal(insert.params[2], 'order'); // category derived from event
});

test('skips an optional order notification when notify_order_updates is false', async () => {
  const client = fakeClient({ prefRow: { allowed: false } });
  const created = await insertNotification(client, base);
  assert.equal(created, false);
  assert.equal(client.calls.some((c) => c.text.startsWith('INSERT INTO notifications')), false);
});

test('order cancellation is essential and ignores the order preference', async () => {
  const client = fakeClient({ prefRow: { allowed: false } });
  const created = await insertNotification(client, {
    ...base, eventType: 'order_cancelled', dedupeKey: 'cancelled:x',
  });
  assert.equal(created, true);
  // Essential events never query the preference table.
  assert.equal(client.calls.some((c) => c.text.includes('notify_order_updates')), false);
});

test('payment and security notifications never consult the preference', async () => {
  for (const eventType of ['payment_paid', 'payment_failed', 'refund_approved', 'password_changed']) {
    const client = fakeClient({ prefRow: { allowed: false } });
    const created = await insertNotification(client, { ...base, eventType, dedupeKey: `${eventType}:x` });
    assert.equal(created, true, `${eventType} should deliver`);
    assert.equal(client.calls.some((c) => c.text.includes('notify_order_updates')), false);
  }
});

test('dedupe: ON CONFLICT DO NOTHING reports not-created without throwing', async () => {
  const client = fakeClient({ prefRow: { allowed: true }, insertRowCount: 0 });
  const created = await insertNotification(client, base);
  assert.equal(created, false);
});

test('a failed insert is contained by the savepoint and never rejects', async () => {
  const client = fakeClient({ prefRow: { allowed: true }, failInsert: true });
  const created = await insertNotification(client, base);
  assert.equal(created, false);
  // The failure path rolls back to the savepoint so the parent transaction can continue.
  assert.ok(client.calls.some((c) => c.text.startsWith('ROLLBACK TO SAVEPOINT')));
});

test('rejects unknown event types and malformed internal link paths', async () => {
  const unknown = fakeClient();
  assert.equal(await insertNotification(unknown, { ...base, eventType: 'nope' }), false);

  // An off-site link is dropped (stored as null) rather than persisted.
  const external = fakeClient({ prefRow: { allowed: true } });
  await insertNotification(external, { ...base, linkPath: 'https://evil.example/phish' });
  const insert = external.calls.find((c) => c.text.startsWith('INSERT INTO notifications'));
  assert.equal(insert.params[6], null);
});

test('listNotifications shapes rows, bounds the page, and returns a cursor', async () => {
  const rows = Array.from({ length: 21 }, (_, i) => ({
    id: `pub-${i}`, category: 'order', eventType: 'order_placed', title: 'T', body: 'B',
    linkPath: '/orders/x', readAt: null, createdAt: new Date('2026-10-26T00:00:00Z'), internalId: 100 - i,
  }));
  const dbQuery = async () => ({ rows, rowCount: rows.length });
  const page = await listNotifications(dbQuery, 7, { limit: 20 });
  assert.equal(page.notifications.length, 20);
  assert.equal(page.notifications[0].read, false);
  assert.ok(page.nextCursor);
});

test('unreadCount and mark operations are owner-scoped', async () => {
  let countParams;
  assert.equal(await unreadCount(async (_t, p) => { countParams = p; return { rows: [{ count: 3 }] }; }, 7), 3);
  assert.deepEqual(countParams, [7]);

  let readParams;
  assert.equal(await markNotificationRead(async (_t, p) => { readParams = p; return { rowCount: 1 }; }, 7, 'pub-1'), true);
  assert.deepEqual(readParams, [7, 'pub-1']);
  assert.equal(await markNotificationRead(async () => ({ rowCount: 0 }), 7, 'missing'), false);

  assert.equal(await markAllNotificationsRead(async (_t, p) => { assert.deepEqual(p, [7]); return { rowCount: 4 }; }, 7), 4);
});
