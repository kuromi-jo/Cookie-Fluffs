/**
 * @file reviews.js
 * @description Cookie reviews. Customers rate the cookies from a completed order (one review per cookie
 * per order); every review is public on the cookie's page and shows up in the admin activity feed.
 *   GET  /api/orders/:id/reviews        cookies in the order and the customer's review for each
 *   POST /api/orders/:id/reviews        { productId, rating 1-5, comment? }
 *   GET  /api/products/:id/reviews      public list with average and count
 */
import crypto from 'node:crypto';
import { Router } from 'express';
import { PRODUCT_REVIEWS_SCHEMA, query } from '../db.js';
import { requireAuth } from '../auth.js';

export const ordersReviewsRouter = Router();
export const productReviewsRouter = Router();

const COMMENT_MAX = 500;
let ready = null;

/** The server never auto-migrates, so the reviews table is created the first time it is needed. */
export function ensureReviewsTable() {
  ready ??= query(PRODUCT_REVIEWS_SCHEMA).catch((err) => {
    ready = null;
    throw err;
  });
  return ready;
}

async function ownOrder(publicId, userId) {
  const { rows } = await query(
    `SELECT id, order_status AS status FROM orders WHERE public_id::text = $1 AND user_id = $2`,
    [String(publicId), userId],
  );
  return rows[0] ?? null;
}

/** Every distinct cookie in the order: single lines plus the cookies inside boxes. */
async function orderCookies(orderId) {
  const { rows } = await query(
    `SELECT DISTINCT ON (p.id) p.id AS "productId", p.name, p.image_url AS "imageUrl"
     FROM (
       SELECT product_id FROM order_items WHERE order_id = $1 AND product_id IS NOT NULL
       UNION
       SELECT bi.product_id FROM order_box_items bi JOIN order_items oi ON oi.id = bi.order_item_id
       WHERE oi.order_id = $1 AND bi.product_id IS NOT NULL
     ) x JOIN products p ON p.id = x.product_id
     ORDER BY p.id`,
    [orderId],
  );
  return rows;
}

// GET /api/orders/:id/reviews
ordersReviewsRouter.get('/:id/reviews', requireAuth, async (req, res, next) => {
  try {
    await ensureReviewsTable();
    const order = await ownOrder(req.params.id, req.userId);
    if (!order) return res.status(404).json({ message: 'We couldn’t find this order for your account.' });
    const cookies = await orderCookies(order.id);
    const { rows } = await query(
      'SELECT product_id AS "productId", rating, comment, is_anonymous AS anonymous FROM product_reviews WHERE order_id = $1',
      [order.id],
    );
    const mine = new Map(rows.map((r) => [r.productId, { rating: r.rating, comment: r.comment, anonymous: r.anonymous }]));
    res.json({
      canReview: order.status === 'completed',
      items: cookies.map((c) => ({ ...c, review: mine.get(c.productId) ?? null })),
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/orders/:id/reviews
ordersReviewsRouter.post('/:id/reviews', requireAuth, async (req, res, next) => {
  try {
    const productId = Number(req.body?.productId);
    const rating = Number(req.body?.rating);
    const comment = typeof req.body?.comment === 'string' ? req.body.comment.trim() : '';
    const anonymous = req.body?.anonymous === true;
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
      return res.status(400).json({ message: 'Choose a rating from 1 to 5 stars.' });
    }
    if (comment.length > COMMENT_MAX) {
      return res.status(400).json({ message: `Keep your review under ${COMMENT_MAX} characters.` });
    }
    await ensureReviewsTable();
    const order = await ownOrder(req.params.id, req.userId);
    if (!order) return res.status(404).json({ message: 'We couldn’t find this order for your account.' });
    if (order.status !== 'completed') {
      return res.status(409).json({ message: 'You can review your cookies once the order is completed.' });
    }
    const cookies = await orderCookies(order.id);
    if (!Number.isInteger(productId) || !cookies.some((c) => c.productId === productId)) {
      return res.status(400).json({ message: 'That cookie is not part of this order.' });
    }
    await query(
      `INSERT INTO product_reviews (public_id, user_id, order_id, product_id, rating, comment, is_anonymous)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (order_id, product_id)
       DO UPDATE SET rating = EXCLUDED.rating, comment = EXCLUDED.comment, is_anonymous = EXCLUDED.is_anonymous, created_at = now()`,
      [crypto.randomUUID(), req.userId, order.id, productId, rating, comment || null, anonymous],
    );
    // The cookie's star rating now comes from real reviews.
    await query(
      `UPDATE products p SET rating = s.avg, reviews_count = s.n
       FROM (SELECT round(avg(rating)::numeric, 1) AS avg, count(*)::int AS n
             FROM product_reviews WHERE product_id = $1) s
       WHERE p.id = $1`,
      [productId],
    );
    res.status(201).json({ productId, rating, comment: comment || null, anonymous });
  } catch (err) {
    next(err);
  }
});

// GET /api/products/:id/reviews
productReviewsRouter.get('/:id/reviews', async (req, res, next) => {
  try {
    const productId = Number(req.params.id);
    if (!Number.isInteger(productId) || productId < 1) return res.json({ average: 0, count: 0, reviews: [] });
    await ensureReviewsTable();
    const { rows } = await query(
      `SELECT r.public_id AS id, r.rating, r.comment, r.created_at AS "createdAt",
              CASE WHEN r.is_anonymous THEN 'Anonymous customer'
                   ELSE COALESCE(NULLIF(u.first_name, ''), split_part(u.full_name, ' ', 1)) END AS name
       FROM product_reviews r JOIN users u ON u.id = r.user_id
       WHERE r.product_id = $1
       ORDER BY r.created_at DESC LIMIT 50`,
      [productId],
    );
    const count = rows.length;
    const average = count ? Math.round((rows.reduce((s, r) => s + r.rating, 0) / count) * 10) / 10 : 0;
    res.json({ average, count, reviews: rows });
  } catch (err) {
    next(err);
  }
});
