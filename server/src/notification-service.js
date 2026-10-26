/**
 * @file notification-service.js
 * @description Owner-scoped in-app notifications written inside the business transaction
 * that caused them. Optional order-progress items respect notify_order_updates; essential
 * payment and security items always deliver. A notification write never aborts its parent
 * operation: the INSERT runs inside a SAVEPOINT and any failure is contained.
 */
import crypto from 'node:crypto';

const MAX_PAGE_SIZE = 30;
const DEFAULT_PAGE_SIZE = 20;
const INTERNAL_PATH_RE = /^\/[A-Za-z0-9/_-]*$/;

// Categories whose delivery a customer can opt out of. Payment and security are essential
// and are never gated by a preference.
const OPTIONAL_CATEGORIES = new Set(['order']);

// Essentiality decision (correction A): order PLACEMENT and in-progress status updates
// (confirmed/preparing/ready/out_for_delivery/completed) are OPTIONAL order-progress and
// respect notify_order_updates. Order CANCELLATION is ESSENTIAL — a customer must always
// learn an order was cancelled — so it is exempt from the optional gate even though it
// shares the 'order' category. Payment and security are always essential.
const ESSENTIAL_EVENT_EXEMPTIONS = new Set(['order_cancelled']);

const EVENT_CATEGORY = Object.freeze({
  order_placed: 'order',
  order_confirmed: 'order',
  order_preparing: 'order',
  order_ready: 'order',
  order_out_for_delivery: 'order',
  order_completed: 'order',
  order_cancelled: 'order',
  payment_paid: 'payment',
  payment_failed: 'payment',
  refund_approved: 'payment',
  refund_rejected: 'payment',
  password_changed: 'security',
  security_alert: 'security',
});

function clamp(text, max) {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim();
  return value.length > max ? value.slice(0, max) : value;
}

/**
 * Whether the owner currently accepts this optional category. Essential categories always
 * return true. Reads notify_order_updates inside the same transaction client so a preference
 * change is honoured atomically and never deletes existing history.
 */
async function optionalCategoryAllowed(client, userId, category, eventType) {
  if (!OPTIONAL_CATEGORIES.has(category) || ESSENTIAL_EVENT_EXEMPTIONS.has(eventType)) return true;
  const { rows } = await client.query(
    'SELECT notify_order_updates AS "allowed" FROM user_preferences WHERE user_id = $1',
    [userId],
  );
  // No saved row means the column default (true) applies.
  return rows.length ? rows[0].allowed !== false : true;
}

/**
 * Inserts one notification using the caller's transaction client. Returns true when a row
 * was created, false when skipped (preference off, duplicate, or a contained write error).
 *
 * Reliability contract:
 *  - Runs inside the parent transaction, so if that transaction later rolls back, the
 *    notification is discarded too (no false notifications).
 *  - Wrapped in a SAVEPOINT: a notification failure (e.g. constraint/db hiccup) is rolled
 *    back to the savepoint and swallowed, so it can NEVER abort the order/payment/security
 *    operation that owns the transaction.
 *  - Deduplicates on (user_id, dedupe_key) via ON CONFLICT DO NOTHING, so replayed source
 *    events (webhooks, retried transitions) do not create duplicates.
 */
export async function insertNotification(client, {
  userId, eventType, title, body, linkPath = null, dedupeKey,
  randomUUID = crypto.randomUUID,
}) {
  const category = EVENT_CATEGORY[eventType];
  if (!category) return false;
  if (!Number.isInteger(userId) || userId <= 0) return false;
  if (!dedupeKey || typeof dedupeKey !== 'string') return false;
  if (linkPath !== null && !INTERNAL_PATH_RE.test(linkPath)) {
    // Server-side validation of internal navigation paths: never store an off-site or
    // malformed link. Drop the link rather than storing something unsafe.
    linkPath = null;
  }
  const safeTitle = clamp(title, 120);
  const safeBody = clamp(body, 300);
  if (!safeTitle || !safeBody) return false;

  await client.query('SAVEPOINT cf_notification');
  try {
    if (!(await optionalCategoryAllowed(client, userId, category, eventType))) {
      await client.query('RELEASE SAVEPOINT cf_notification');
      return false;
    }
    const result = await client.query(
      `INSERT INTO notifications (public_id, user_id, category, event_type, title, body, link_path, dedupe_key)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (user_id, dedupe_key) DO NOTHING`,
      [randomUUID(), userId, category, eventType, safeTitle, safeBody, linkPath, dedupeKey],
    );
    await client.query('RELEASE SAVEPOINT cf_notification');
    return result.rowCount > 0;
  } catch {
    // Contain any failure so the parent business operation still commits.
    await client.query('ROLLBACK TO SAVEPOINT cf_notification').catch(() => undefined);
    await client.query('RELEASE SAVEPOINT cf_notification').catch(() => undefined);
    return false;
  }
}

function shapeNotification(row) {
  return {
    id: row.id,
    category: row.category,
    eventType: row.eventType,
    title: row.title,
    body: row.body,
    linkPath: row.linkPath,
    read: row.readAt !== null,
    createdAt: row.createdAt,
  };
}

const LIST_SELECT = `
  public_id AS id, category, event_type AS "eventType", title, body,
  link_path AS "linkPath", read_at AS "readAt", created_at AS "createdAt"`;

/** Lists one owner's notifications with bounded keyset pagination (newest first). */
export async function listNotifications(dbQuery, userId, { limit, cursor } = {}) {
  const pageSize = Math.min(
    Math.max(Number.isInteger(limit) ? limit : DEFAULT_PAGE_SIZE, 1),
    MAX_PAGE_SIZE,
  );
  const params = [userId];
  let cursorClause = '';
  if (cursor) {
    const decoded = decodeCursor(cursor);
    if (decoded) {
      params.push(decoded.createdAt, decoded.id);
      cursorClause = `AND (created_at, id) < ($2::timestamptz, $3::bigint)`;
    }
  }
  params.push(pageSize + 1);
  const { rows } = await dbQuery(
    `SELECT ${LIST_SELECT}, id AS "internalId"
     FROM notifications
     WHERE user_id = $1 ${cursorClause}
     ORDER BY created_at DESC, id DESC
     LIMIT $${params.length}`,
    params,
  );
  const hasMore = rows.length > pageSize;
  const page = hasMore ? rows.slice(0, pageSize) : rows;
  const last = page[page.length - 1];
  return {
    notifications: page.map(shapeNotification),
    nextCursor: hasMore && last ? encodeCursor(last.createdAt, last.internalId) : null,
  };
}

/** Returns the owner's unread notification count. */
export async function unreadCount(dbQuery, userId) {
  const { rows } = await dbQuery(
    'SELECT count(*)::int AS count FROM notifications WHERE user_id = $1 AND read_at IS NULL',
    [userId],
  );
  return rows[0]?.count ?? 0;
}

/** Marks one owned notification read (idempotent). Returns false when not owned/found. */
export async function markNotificationRead(dbQuery, userId, publicId) {
  const { rowCount } = await dbQuery(
    `UPDATE notifications SET read_at = COALESCE(read_at, now())
     WHERE user_id = $1 AND public_id = $2`,
    [userId, publicId],
  );
  return rowCount > 0;
}

/** Marks all of the owner's unread notifications read. Returns the number updated. */
export async function markAllNotificationsRead(dbQuery, userId) {
  const { rowCount } = await dbQuery(
    'UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL',
    [userId],
  );
  return rowCount;
}

function encodeCursor(createdAt, id) {
  const iso = createdAt instanceof Date ? createdAt.toISOString() : String(createdAt);
  return Buffer.from(`${iso}|${id}`, 'utf8').toString('base64url');
}

function decodeCursor(cursor) {
  try {
    const [iso, id] = Buffer.from(String(cursor), 'base64url').toString('utf8').split('|');
    const numericId = Number(id);
    if (!iso || !Number.isInteger(numericId)) return null;
    if (Number.isNaN(new Date(iso).getTime())) return null;
    return { createdAt: iso, id: numericId };
  } catch {
    return null;
  }
}

export const notificationLimits = Object.freeze({ maxPageSize: MAX_PAGE_SIZE, defaultPageSize: DEFAULT_PAGE_SIZE });
