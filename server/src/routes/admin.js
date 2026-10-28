/**
 * @file admin.js (routes)
 * @description Superadmin dashboard API: sales overview, orders with status changes,
 * product price / promo / availability edits, and the admin activity feed.
 */
import crypto from 'node:crypto';
import { Router } from 'express';
import { PRODUCT_IMAGES_SCHEMA, pool, query } from '../db.js';
import { requireSuperAdmin, superadminOperator } from '../admin.js';
import { TRANSITIONS, advanceOrderStatus, resolveCancellationRequest } from '../order-lifecycle.js';
import { ensureReviewsTable } from './reviews.js';
import { BEST_SELLERS_CTE } from '../best-sellers.js';

const router = Router();
router.use(requireSuperAdmin);

const STATUSES = new Set(['placed', 'confirmed', 'preparing', 'ready', 'out_for_delivery', 'completed', 'cancelled']);
const httpError = (status, message) => Object.assign(new Error(message), { status });
const money = (v) => Number(v ?? 0);

/** "%text%" for an ILIKE search (wildcards typed by the admin are matched literally), or null for no search. */
function likePattern(value) {
  const text = typeof value === 'string' ? value.trim().slice(0, 80) : '';
  return text ? `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
}

// GET /api/admin/summary
router.get('/summary', async (_req, res, next) => {
  try {
    const totals = await query(
      `SELECT
         COALESCE(sum(order_total) FILTER (WHERE order_status <> 'cancelled'), 0) AS "totalSales",
         COALESCE(sum(order_total) FILTER (WHERE order_status <> 'cancelled'
           AND (created_at AT TIME ZONE 'Asia/Manila')::date = (now() AT TIME ZONE 'Asia/Manila')::date), 0) AS "todaySales",
         count(*) FILTER (WHERE (created_at AT TIME ZONE 'Asia/Manila')::date = (now() AT TIME ZONE 'Asia/Manila')::date) AS "todayOrders",
         count(*) AS "totalOrders",
         count(*) FILTER (WHERE order_status NOT IN ('completed', 'cancelled')) AS "activeOrders",
         count(*) FILTER (WHERE order_status = 'placed') AS "newOrders"
       FROM orders`,
    );
    const pending = await query(`SELECT count(*) AS n FROM order_cancellation_requests WHERE status = 'pending'`);
    // Same ranking the customer app shows under "Best sellers" (see best-sellers.js).
    const best = await query(
      `WITH ${BEST_SELLERS_CTE}
       SELECT p.id, p.name, p.image_url AS "imageUrl", b.sold
       FROM best b JOIN products p ON p.id = b.id
       ORDER BY b.rank`,
    );
    const t = totals.rows[0];
    res.json({
      todaySales: money(t.todaySales),
      totalSales: money(t.totalSales),
      todayOrders: Number(t.todayOrders),
      totalOrders: Number(t.totalOrders),
      activeOrders: Number(t.activeOrders),
      newOrders: Number(t.newOrders),
      pendingCancellations: Number(pending.rows[0].n),
      bestSellers: best.rows,
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/admin/orders?status=placed  (or status=cancel_requests for orders awaiting a cancellation decision)
router.get('/orders', async (req, res, next) => {
  try {
    const status = typeof req.query.status === 'string' && STATUSES.has(req.query.status) ? req.query.status : null;
    const { rows } = await query(
      `SELECT o.public_id AS id, o.order_status AS status, o.payment_status AS "paymentStatus",
              o.fulfillment_method AS fulfillment, o.contact_name AS "customerName", o.contact_phone AS phone,
              concat_ws(', ', o.address_line_1, o.barangay, o.city) AS address, o.notes,
              o.order_total AS total, o.created_at AS "createdAt",
              (SELECT string_agg(
                        CASE WHEN oi.line_type = 'box' THEN 'Box of ' || oi.pack_size ELSE oi.display_name END
                        || ' x' || oi.quantity, ', ' ORDER BY oi.line_position)
               FROM order_items oi WHERE oi.order_id = o.id) AS items,
              (SELECT r.public_id FROM order_cancellation_requests r
               WHERE r.order_id = o.id AND r.status = 'pending' LIMIT 1) AS "cancellationRequestId"
       FROM orders o
       WHERE ($1::text IS NULL OR o.order_status = $1)
         AND (NOT $2::boolean OR EXISTS (SELECT 1 FROM order_cancellation_requests r
                                         WHERE r.order_id = o.id AND r.status = 'pending'))
         -- ?q= matches the customer name, phone, address, order number or any cookie in the order
         AND ($3::text IS NULL
              OR o.contact_name ILIKE $3 OR o.contact_phone ILIKE $3 OR o.public_id::text ILIKE $3
              OR concat_ws(' ', o.address_line_1, o.address_line_2, o.barangay, o.city, o.province) ILIKE $3
              OR EXISTS (SELECT 1 FROM order_items oi WHERE oi.order_id = o.id AND oi.display_name ILIKE $3)
              OR EXISTS (SELECT 1 FROM order_box_items bi JOIN order_items oi ON oi.id = bi.order_item_id
                         WHERE oi.order_id = o.id AND bi.product_name ILIKE $3))
       ORDER BY o.created_at DESC
       LIMIT 100`,
      [status, req.query.status === 'cancel_requests', likePattern(req.query.q)],
    );
    res.json(
      rows.map((r) => ({
        ...r,
        total: money(r.total),
        nextStatus: TRANSITIONS[r.fulfillment]?.[r.status] ?? null,
      })),
    );
  } catch (err) {
    next(err);
  }
});

/** Runs an order-lifecycle operation as the superadmin operator on a dedicated client. */
async function asOperator(fn) {
  const client = await pool.connect();
  try {
    const operator = await superadminOperator(client);
    return await fn(client, operator);
  } finally {
    client.release();
  }
}

// POST /api/admin/orders/:id/advance  { status }
router.post('/orders/:id/advance', async (req, res, next) => {
  try {
    const status = String(req.body?.status ?? '');
    const result = await asOperator((client, op) =>
      advanceOrderStatus(client, op, req.params.id, status, crypto.randomUUID()),
    );
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// POST /api/admin/cancellations/:id  { decision: 'approve' | 'decline' }
router.post('/cancellations/:id', async (req, res, next) => {
  try {
    const decision = String(req.body?.decision ?? '');
    const result = await asOperator((client, op) =>
      resolveCancellationRequest(client, op, req.params.id, decision, crypto.randomUUID()),
    );
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// GET /api/admin/products
router.get('/products', async (_req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT id, name, category, image_url AS "imageUrl", price::float AS price,
              sale_price::float AS "salePrice", is_available AS "isAvailable"
       FROM products ORDER BY is_available DESC, name`,
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

function parsePrice(value, label) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0 || n > 100000 || Math.round(n * 100) !== n * 100) {
    throw httpError(400, `${label} must be a peso amount above ₱0.`);
  }
  return n;
}

// PATCH /api/admin/products/:id  { price?, salePrice? (null clears the promo), isAvailable? }
router.patch('/products/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const current = await query('SELECT price::float AS price, sale_price::float AS "salePrice" FROM products WHERE id = $1', [id]);
    if (!current.rowCount) throw httpError(404, 'That cookie was not found.');
    const body = req.body ?? {};
    const price = body.price === undefined ? current.rows[0].price : parsePrice(body.price, 'Price');
    const salePrice =
      body.salePrice === undefined ? current.rows[0].salePrice : body.salePrice === null ? null : parsePrice(body.salePrice, 'Promo price');
    if (salePrice !== null && salePrice >= price) throw httpError(400, 'Promo price must be lower than the regular price.');
    if (body.isAvailable !== undefined && typeof body.isAvailable !== 'boolean') throw httpError(400, 'Availability must be on or off.');
    // A promo price shows "N% off" automatically; removing it also removes that discount badge.
    const { rows } = await query(
      `UPDATE products SET price = $2, sale_price = $3, is_available = COALESCE($4, is_available),
              badge = CASE WHEN $3::numeric IS NOT NULL THEN $5
                           WHEN badge ~ '^[0-9]+% off$' THEN CASE WHEN season = 'halloween' THEN 'Halloween' END
                           ELSE badge END
       WHERE id = $1
       RETURNING id, name, category, image_url AS "imageUrl", price::float AS price,
                 sale_price::float AS "salePrice", is_available AS "isAvailable", badge`,
      [id, price, salePrice, body.isAvailable ?? null, salePrice === null ? null : discountBadge(price, salePrice)],
    );
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

/* ---------------------------------------------------------------- add product */

export const PRODUCT_CATEGORIES = ['classic', 'indulgent', 'fruity', 'nutty', 'dietary'];
export const PRODUCT_SEASONS = ['halloween'];
export const PRODUCT_ALLERGENS = ['Gluten', 'Dairy', 'Eggs', 'Peanuts', 'Tree Nuts', 'Soy'];
/** Badge choices in the admin form. A promo price always replaces them with an automatic "N% off" badge. */
export const PRODUCT_BADGES = ['New', 'Halloween'];
const MAX_ALLERGENS = 10;

/** "25% off" from the regular and promo price (never 0%). */
export function discountBadge(price, salePrice) {
  return `${Math.max(1, Math.round((1 - salePrice / price) * 100))}% off`;
}

/** Known allergens keep their usual spelling; custom ones are tidied ("tree  nuts" -> "Tree nuts"). */
function parseAllergens(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw httpError(400, 'Allergens must be a list.');
  const seen = new Map();
  for (const raw of value) {
    const cleaned = typeof raw === 'string' ? raw.trim().replace(/\s+/g, ' ') : '';
    if (cleaned.length < 2 || cleaned.length > 24 || !/^[A-Za-z][A-Za-z .'&-]*$/.test(cleaned)) {
      throw httpError(400, 'Each allergen needs 2 to 24 letters, like “Sesame”.');
    }
    const known = PRODUCT_ALLERGENS.find((a) => a.toLowerCase() === cleaned.toLowerCase());
    const label = known ?? cleaned.charAt(0).toUpperCase() + cleaned.slice(1).toLowerCase();
    seen.set(label.toLowerCase(), label);
  }
  if (seen.size > MAX_ALLERGENS) throw httpError(400, `List up to ${MAX_ALLERGENS} allergens.`);
  return [...seen.values()];
}
const MAX_IMAGE_BYTES = 700 * 1024;
let imagesTableReady = false;

function text(value, label, min, max, { required = true } = {}) {
  const v = typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
  if (!v && !required) return null;
  if (v.length < min || v.length > max) throw httpError(400, `${label} needs ${min} to ${max} characters.`);
  return v;
}

function parseImage(dataUrl) {
  const m = typeof dataUrl === 'string' ? /^data:(image\/(?:webp|png|jpeg));base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl) : null;
  if (!m) throw httpError(400, 'Add a product photo (WebP, PNG or JPEG).');
  const data = Buffer.from(m[2], 'base64');
  if (!data.length || data.length > MAX_IMAGE_BYTES) throw httpError(400, 'The photo is too large. Use one under 700 KB.');
  return { mime: m[1], data };
}

function slugify(name) {
  return name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'cookie';
}

// POST /api/admin/products  (all fields of a new cookie, image as a data URL)
router.post('/products', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const b = req.body ?? {};
    const name = text(b.name, 'Name', 2, 60);
    const tagline = text(b.tagline, 'Tagline', 2, 120);
    const description = text(b.description, 'Description', 10, 600);
    const flavorNotes = text(b.flavorNotes, 'Flavor notes', 2, 80);
    if (!PRODUCT_CATEGORIES.includes(b.category)) throw httpError(400, 'Choose a category.');
    const season = b.season === null || b.season === undefined || b.season === '' ? null : b.season;
    if (season !== null && !PRODUCT_SEASONS.includes(season)) throw httpError(400, 'Choose a valid season.');
    const price = parsePrice(b.price, 'Price');
    const salePrice = b.salePrice === null || b.salePrice === undefined || b.salePrice === '' ? null : parsePrice(b.salePrice, 'Promo price');
    if (salePrice !== null && salePrice >= price) throw httpError(400, 'Promo price must be lower than the regular price.');
    const chosenBadge = b.badge === null || b.badge === undefined || b.badge === '' ? null : b.badge;
    if (chosenBadge !== null && !PRODUCT_BADGES.includes(chosenBadge)) throw httpError(400, 'Choose a badge from the list.');
    // A promo price always shows its discount; otherwise the chosen badge (or the Halloween one).
    const badge = salePrice !== null ? discountBadge(price, salePrice) : chosenBadge ?? (season === 'halloween' ? 'Halloween' : null);
    const calories = Number(b.calories ?? 0);
    if (!Number.isInteger(calories) || calories < 0 || calories > 2000) throw httpError(400, 'Calories must be a whole number from 0 to 2000.');
    const allergens = parseAllergens(b.allergens);
    for (const flag of ['isBestSeller', 'isNew', 'isAvailable']) {
      if (b[flag] !== undefined && typeof b[flag] !== 'boolean') throw httpError(400, 'Switches must be on or off.');
    }
    const image = parseImage(b.image);

    if (!imagesTableReady) {
      await client.query(PRODUCT_IMAGES_SCHEMA);
      imagesTableReady = true;
    }
    await client.query('BEGIN');
    const base = slugify(name);
    const taken = await client.query(`SELECT slug FROM products WHERE slug = $1 OR slug LIKE $1 || '-%'`, [base]);
    const used = new Set(taken.rows.map((r) => r.slug));
    let slug = base;
    for (let n = 2; used.has(slug); n++) slug = `${base}-${n}`;

    const inserted = await client.query(
      `INSERT INTO products
         (slug, name, tagline, description, flavor_notes, category, price, sale_price, calories,
          allergens, badge, image_url, is_available, is_best_seller, is_new, season)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, '', $12, $13, $14, $15)
       RETURNING id`,
      [slug, name, tagline, description, flavorNotes, b.category, price, salePrice, calories, allergens, badge,
        b.isAvailable ?? true, b.isBestSeller ?? false, chosenBadge === 'New' || (b.isNew ?? true), season],
    );
    const id = inserted.rows[0].id;
    await client.query('INSERT INTO product_images (product_id, mime_type, data) VALUES ($1, $2, $3)', [id, image.mime, image.data]);
    const { rows } = await client.query(
      `UPDATE products SET image_url = $2 WHERE id = $1
       RETURNING id, name, category, image_url AS "imageUrl", price::float AS price,
                 sale_price::float AS "salePrice", is_available AS "isAvailable"`,
      [id, `/api/products/${id}/image?v=${Date.now()}`],
    );
    await client.query('COMMIT');
    res.status(201).json(rows[0]);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    next(err);
  } finally {
    client.release();
  }
});

/* ---------------------------------------------------------------- reviews (read only) */

// GET /api/admin/reviews  -> { average, count, reviews }  Customers own their reviews; the admin can only read them.
router.get('/reviews', async (_req, res, next) => {
  try {
    await ensureReviewsTable();
    const { rows } = await query(
      `SELECT rv.public_id AS id, rv.rating, rv.comment, rv.is_anonymous AS anonymous, rv.created_at AS "createdAt",
              p.id AS "productId", p.name AS "productName", p.image_url AS "imageUrl",
              o.contact_name AS "customerName", o.public_id AS "orderId"
       FROM product_reviews rv
       JOIN products p ON p.id = rv.product_id
       JOIN orders o ON o.id = rv.order_id
       ORDER BY rv.created_at DESC
       LIMIT 200`,
    );
    const stats = await query('SELECT count(*)::int AS count, COALESCE(round(avg(rating)::numeric, 1), 0)::float AS average FROM product_reviews');
    res.json({ ...stats.rows[0], reviews: rows });
  } catch (err) {
    next(err);
  }
});

/* ---------------------------------------------------------------- contact messages (read only) */

export const CONTACT_TOPICS = ['General question', 'Order concern', 'Bulk / event order', 'Feedback', 'Partnership'];

// GET /api/admin/messages?q=&topic=&from=accounts|guests
//   q matches name, email, topic or message text.
router.get('/messages', async (req, res, next) => {
  try {
    const topic = CONTACT_TOPICS.includes(req.query.topic) ? req.query.topic : null;
    const from = req.query.from === 'accounts' || req.query.from === 'guests' ? req.query.from : null;
    const { rows } = await query(
      `SELECT m.id, m.name, m.email, m.subject AS topic, m.message, m.created_at AS "createdAt",
              (m.user_id IS NOT NULL) AS "fromAccount", u.phone AS "accountPhone"
       FROM contact_messages m LEFT JOIN users u ON u.id = m.user_id
       WHERE ($1::text IS NULL OR m.name ILIKE $1 OR m.email ILIKE $1 OR m.subject ILIKE $1 OR m.message ILIKE $1)
         AND ($2::text IS NULL OR m.subject = $2)
         AND ($3::text IS NULL OR ($3 = 'accounts') = (m.user_id IS NOT NULL))
       ORDER BY m.created_at DESC
       LIMIT 200`,
      [likePattern(req.query.q), topic, from],
    );
    const total = await query('SELECT count(*)::int AS n FROM contact_messages');
    res.json({ total: total.rows[0].n, topics: CONTACT_TOPICS, messages: rows });
  } catch (err) {
    next(err);
  }
});

/* ---------------------------------------------------------------- activity feed */

const FEED_SEEN_KEY = 'admin_feed_seen_at';

async function feedSeenAt() {
  const { rows } = await query('SELECT value FROM app_meta WHERE key = $1', [FEED_SEEN_KEY]);
  return rows[0]?.value ?? '1970-01-01T00:00:00Z';
}

// GET /api/admin/feed  -> { items, unread }  (new orders, cancellation requests, reviews)
router.get('/feed', async (_req, res, next) => {
  try {
    await ensureReviewsTable();
    const seen = await feedSeenAt();
    const { rows } = await query(
      `SELECT * FROM (
         SELECT 'order' AS kind, o.public_id AS "orderId", o.created_at AS at,
                'New order from ' || o.contact_name AS title,
                '₱' || to_char(o.order_total, 'FM999,999,990.00') || ' · ' ||
                  CASE o.fulfillment_method WHEN 'delivery' THEN 'Delivery' ELSE 'Pickup' END AS body,
                NULL::int AS "productId", NULL::uuid AS "reviewId", NULL::jsonb AS message
         FROM orders o
         UNION ALL
         SELECT 'cancellation', o.public_id, r.requested_at,
                o.contact_name || ' asked to cancel an order',
                CASE r.status WHEN 'pending' THEN 'Waiting for your decision' ELSE 'Resolved: ' || r.status END,
                NULL::int, NULL::uuid, NULL::jsonb
         FROM order_cancellation_requests r JOIN orders o ON o.id = r.order_id
         UNION ALL
         SELECT 'review', o.public_id, rv.created_at,
                CASE WHEN rv.is_anonymous THEN 'A customer (anonymous)' ELSE o.contact_name END || ' rated ' || p.name || ' ' || rv.rating || ' of 5',
                COALESCE(left(rv.comment, 120), 'No comment'),
                p.id, rv.public_id, NULL::jsonb
         FROM product_reviews rv JOIN orders o ON o.id = rv.order_id JOIN products p ON p.id = rv.product_id
         UNION ALL
         SELECT 'message', NULL::uuid, m.created_at,
                'New message from ' || m.name,
                m.subject || ' · ' || left(m.message, 100),
                NULL::int, NULL::uuid,
                jsonb_build_object('id', m.id, 'name', m.name, 'email', m.email, 'subject', m.subject, 'message', m.message)
         FROM contact_messages m
       ) feed
       ORDER BY at DESC LIMIT 30`,
    );
    const items = rows.map((r) => ({ ...r, unread: new Date(r.at) > new Date(seen) }));
    res.json({ items, unread: items.filter((i) => i.unread).length });
  } catch (err) {
    next(err);
  }
});

// POST /api/admin/feed/seen
router.post('/feed/seen', async (_req, res, next) => {
  try {
    await query(
      `INSERT INTO app_meta (key, value) VALUES ($1, now()::text)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [FEED_SEEN_KEY],
    );
    res.json({ unread: 0 });
  } catch (err) {
    next(err);
  }
});

export default router;
