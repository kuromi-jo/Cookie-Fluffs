/**
 * @file live.js
 * @description Live updates over Server-Sent Events (GET /api/live). One shared watcher checks the
 * database every 2 seconds for new notifications, order changes and cancellation requests, then pushes
 * a small event to the affected customers and to the admin. Catches every change source (app, admin,
 * payment webhooks, CLI) without touching the code that makes the change.
 */
import { Router } from 'express';
import { query } from '../db.js';
import { requireAuth } from '../auth.js';
import { isSuperAdmin } from '../admin.js';
import { ensureReviewsTable } from './reviews.js';

const router = Router();
const WATCH_MS = 2000;
const HEARTBEAT_MS = 25000;

/** @type {Set<{ res: import('express').Response, userId: number, isAdmin: boolean }>} */
const clients = new Set();
let cursor = null;
let timer = null;

function send(client, event, data = {}) {
  client.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

async function readCursor() {
  await ensureReviewsTable();
  const { rows } = await query(
    `SELECT (SELECT COALESCE(max(id), 0) FROM notifications) AS "notificationId",
            (SELECT max(updated_at) FROM orders) AS "orderAt",
            (SELECT GREATEST(max(requested_at), max(resolved_at)) FROM order_cancellation_requests) AS "cancelAt",
            (SELECT max(created_at) FROM product_reviews) AS "reviewAt",
            (SELECT max(created_at) FROM contact_messages) AS "messageAt"`,
  );
  return rows[0];
}

const later = (a, b) => (a ? new Date(a).getTime() : 0) > (b ? new Date(b).getTime() : 0);

async function watch() {
  try {
    const next = await readCursor();
    if (!cursor) {
      cursor = next;
      return;
    }
    let adminChanged = false;
    if (Number(next.notificationId) > Number(cursor.notificationId)) {
      const { rows } = await query('SELECT DISTINCT user_id AS "userId" FROM notifications WHERE id > $1', [cursor.notificationId]);
      const users = new Set(rows.map((r) => r.userId));
      for (const c of clients) if (users.has(c.userId)) send(c, 'notification');
    }
    if (later(next.orderAt, cursor.orderAt)) {
      adminChanged = true;
      const { rows } = await query(
        'SELECT user_id AS "userId", public_id AS "orderId" FROM orders WHERE updated_at > $1',
        [cursor.orderAt ?? new Date(0)],
      );
      for (const c of clients) {
        for (const r of rows) if (r.userId === c.userId) send(c, 'order', { orderId: r.orderId });
      }
    }
    if (later(next.cancelAt, cursor.cancelAt) || later(next.reviewAt, cursor.reviewAt)
      || later(next.messageAt, cursor.messageAt)) adminChanged = true;
    if (adminChanged) for (const c of clients) if (c.isAdmin) send(c, 'admin');
    cursor = next;
  } catch (error) {
    console.error('[live] watcher error:', error.message);
  }
}

function startWatcher() {
  if (timer) return;
  cursor = null;
  void watch();
  timer = setInterval(() => void watch(), WATCH_MS);
}

function stopWatcherIfIdle() {
  if (clients.size || !timer) return;
  clearInterval(timer);
  timer = null;
}

// GET /api/live  (text/event-stream; send the usual "Authorization: Bearer" header)
router.get('/', requireAuth, async (req, res, next) => {
  try {
    const client = { res, userId: req.userId, isAdmin: await isSuperAdmin(req.userId) };
    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();
    send(client, 'ready', { isAdmin: client.isAdmin });
    clients.add(client);
    startWatcher();
    const beat = setInterval(() => res.write(': ping\n\n'), HEARTBEAT_MS);
    req.on('close', () => {
      clearInterval(beat);
      clients.delete(client);
      stopWatcherIfIdle();
    });
  } catch (err) {
    next(err);
  }
});

export default router;
