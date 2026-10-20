/**
 * @file cart.js
 * @description The logged-in user's cart, stored in Neon.
 * A cart holds single cookies (cart_items) and mix-and-match boxes of 4, 6 or 12 (cart_boxes).
 * Only ticked (selected) lines count toward the totals and checkout.
 */
import { Router } from 'express';
import { query, pool } from '../db.js';
import { requireAuth } from '../auth.js';

const router = Router();
router.use(requireAuth);

const DELIVERY_FEE = 49;
const FREE_DELIVERY_MIN = 500;
const MAX_QTY = 99;

/** Box sizes and their mix-and-match discount. Keep in sync with BOX_OPTIONS in app/src/app/core/models.ts. */
export const BOX_DISCOUNTS = { 4: 5, 6: 10, 12: 15 };

const httpError = (status, message) => Object.assign(new Error(message), { status });

/** Loads the cart with product details and totals. Promo prices apply automatically. */
async function loadCart(userId) {
  const singles = await query(
    `SELECT c.product_id AS "productId", c.quantity, c.selected, p.name, p.tagline,
            p.image_url AS "imageUrl", p.category,
            COALESCE(p.sale_price, p.price)::float AS price,
            p.price::float AS "regularPrice",
            (COALESCE(p.sale_price, p.price) * c.quantity)::float AS "lineTotal"
     FROM cart_items c
     JOIN products p ON p.id = c.product_id
     WHERE c.user_id = $1
     ORDER BY c.added_at`,
    [userId],
  );

  const boxRows = await query(
    `SELECT b.id, b.size, b.quantity, b.selected, b.added_at,
            bi.slot, p.id AS "productId", p.name, p.image_url AS "imageUrl",
            COALESCE(p.sale_price, p.price)::float AS price
     FROM cart_boxes b
     JOIN cart_box_items bi ON bi.box_id = b.id
     JOIN products p ON p.id = bi.product_id
     WHERE b.user_id = $1
     ORDER BY b.added_at, b.id, bi.slot`,
    [userId],
  );

  const boxMap = new Map();
  for (const r of boxRows.rows) {
    if (!boxMap.has(r.id)) {
      boxMap.set(r.id, { id: r.id, size: r.size, quantity: r.quantity, selected: r.selected, cookies: [] });
    }
    boxMap.get(r.id).cookies.push({ productId: r.productId, name: r.name, imageUrl: r.imageUrl, price: r.price });
  }
  const boxes = [...boxMap.values()].map((b) => {
    const regularPrice = b.cookies.reduce((sum, c) => sum + c.price, 0);
    const discountPercent = BOX_DISCOUNTS[b.size] ?? 0;
    const price = Math.round(regularPrice * (1 - discountPercent / 100));
    return { ...b, regularPrice, discountPercent, price, lineTotal: price * b.quantity };
  });

  const lines = [...singles.rows, ...boxes];
  const picked = lines.filter((l) => l.selected);
  const subtotal = picked.reduce((sum, l) => sum + l.lineTotal, 0);
  const deliveryFee = subtotal === 0 || subtotal >= FREE_DELIVERY_MIN ? 0 : DELIVERY_FEE;
  return {
    items: singles.rows,
    boxes,
    /** every item in the cart (a box counts as one item); used for the cart badge */
    itemCount: lines.reduce((sum, l) => sum + l.quantity, 0),
    /** ticked items only; used for checkout */
    selectedCount: picked.reduce((sum, l) => sum + l.quantity, 0),
    subtotal,
    deliveryFee,
    freeDeliveryMin: FREE_DELIVERY_MIN,
    total: subtotal + deliveryFee,
  };
}

function parseQty(value, fallback) {
  const qty = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(qty) || qty < 0 || qty > MAX_QTY) {
    throw httpError(400, `Quantity must be a whole number from 0 to ${MAX_QTY}.`);
  }
  return qty;
}

function parseSelected(value) {
  if (typeof value !== 'boolean') throw httpError(400, '"selected" must be true or false.');
  return value;
}

// GET /api/cart
router.get('/', async (req, res, next) => {
  try {
    res.json(await loadCart(req.userId));
  } catch (err) {
    next(err);
  }
});

// POST /api/cart  { productId, quantity }  adds single cookies to whatever is already in the cart
router.post('/', async (req, res, next) => {
  try {
    const productId = Number(req.body.productId);
    const qty = parseQty(req.body.quantity, 1);
    if (qty === 0) return res.status(400).json({ message: 'Add at least one cookie.' });

    const product = await query('SELECT 1 FROM products WHERE id = $1 AND is_available', [productId]);
    if (!product.rowCount) return res.status(404).json({ message: 'That cookie is not available.' });

    await query(
      `INSERT INTO cart_items (user_id, product_id, quantity) VALUES ($1, $2, $3)
       ON CONFLICT (user_id, product_id)
       DO UPDATE SET quantity = LEAST(cart_items.quantity + EXCLUDED.quantity, ${MAX_QTY}), selected = true`,
      [req.userId, productId, qty],
    );
    res.status(201).json(await loadCart(req.userId));
  } catch (err) {
    next(err);
  }
});

// PATCH /api/cart  { selected }  ticks or unticks everything ("Select all")
router.patch('/', async (req, res, next) => {
  try {
    const selected = parseSelected(req.body.selected);
    await query('UPDATE cart_items SET selected = $2 WHERE user_id = $1', [req.userId, selected]);
    await query('UPDATE cart_boxes SET selected = $2 WHERE user_id = $1', [req.userId, selected]);
    res.json(await loadCart(req.userId));
  } catch (err) {
    next(err);
  }
});

// DELETE /api/cart  (empty the whole cart)
router.delete('/', async (req, res, next) => {
  try {
    await query('DELETE FROM cart_items WHERE user_id = $1', [req.userId]);
    await query('DELETE FROM cart_boxes WHERE user_id = $1', [req.userId]);
    res.json(await loadCart(req.userId));
  } catch (err) {
    next(err);
  }
});

/* ---------------------------------------------------------------- boxes */

// POST /api/cart/boxes  { size: 4 | 6 | 12, productIds: number[] }  one id per slot, in slot order
router.post('/boxes', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const size = Number(req.body.size);
    const ids = Array.isArray(req.body.productIds) ? req.body.productIds.map(Number) : [];
    if (!Object.hasOwn(BOX_DISCOUNTS, size)) throw httpError(400, 'Boxes come in 4, 6 or 12.');
    if (ids.length !== size) throw httpError(400, `Fill all ${size} spots in your box first.`);

    const unique = [...new Set(ids)];
    const found = await client.query('SELECT id FROM products WHERE id = ANY($1) AND is_available', [unique]);
    if (found.rowCount !== unique.length) throw httpError(400, 'One of those cookies is no longer available.');

    await client.query('BEGIN');
    const box = await client.query('INSERT INTO cart_boxes (user_id, size) VALUES ($1, $2) RETURNING id', [
      req.userId,
      size,
    ]);
    const boxId = box.rows[0].id;
    await client.query(
      `INSERT INTO cart_box_items (box_id, slot, product_id)
       SELECT $1, s.slot - 1, s.product_id FROM unnest($2::int[]) WITH ORDINALITY AS s(product_id, slot)`,
      [boxId, ids],
    );
    await client.query('COMMIT');
    res.status(201).json(await loadCart(req.userId));
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    next(err);
  } finally {
    client.release();
  }
});

// PATCH /api/cart/boxes/:boxId  { quantity?, selected? }  (quantity 0 removes the box)
router.patch('/boxes/:boxId', async (req, res, next) => {
  try {
    const boxId = Number(req.params.boxId);
    const { quantity, selected } = req.body;
    if (quantity === undefined && selected === undefined) throw httpError(400, 'Send a quantity or a selected value.');
    if (selected !== undefined) {
      await query('UPDATE cart_boxes SET selected = $3 WHERE user_id = $1 AND id = $2', [
        req.userId,
        boxId,
        parseSelected(selected),
      ]);
    }
    if (quantity !== undefined) {
      const qty = parseQty(quantity);
      if (qty === 0) await query('DELETE FROM cart_boxes WHERE user_id = $1 AND id = $2', [req.userId, boxId]);
      else await query('UPDATE cart_boxes SET quantity = $3 WHERE user_id = $1 AND id = $2', [req.userId, boxId, qty]);
    }
    res.json(await loadCart(req.userId));
  } catch (err) {
    next(err);
  }
});

// DELETE /api/cart/boxes/:boxId
router.delete('/boxes/:boxId', async (req, res, next) => {
  try {
    await query('DELETE FROM cart_boxes WHERE user_id = $1 AND id = $2', [req.userId, Number(req.params.boxId)]);
    res.json(await loadCart(req.userId));
  } catch (err) {
    next(err);
  }
});

/* -------------------------------------------------------- single cookies */

// PATCH /api/cart/:productId  { quantity?, selected? }  (quantity 0 removes the cookie)
router.patch('/:productId', async (req, res, next) => {
  try {
    const productId = Number(req.params.productId);
    const { quantity, selected } = req.body;
    if (quantity === undefined && selected === undefined) throw httpError(400, 'Send a quantity or a selected value.');
    if (selected !== undefined) {
      await query('UPDATE cart_items SET selected = $3 WHERE user_id = $1 AND product_id = $2', [
        req.userId,
        productId,
        parseSelected(selected),
      ]);
    }
    if (quantity !== undefined) {
      const qty = parseQty(quantity);
      if (qty === 0) {
        await query('DELETE FROM cart_items WHERE user_id = $1 AND product_id = $2', [req.userId, productId]);
      } else {
        await query('UPDATE cart_items SET quantity = $3 WHERE user_id = $1 AND product_id = $2', [req.userId, productId, qty]);
      }
    }
    res.json(await loadCart(req.userId));
  } catch (err) {
    next(err);
  }
});

// DELETE /api/cart/:productId
router.delete('/:productId', async (req, res, next) => {
  try {
    await query('DELETE FROM cart_items WHERE user_id = $1 AND product_id = $2', [req.userId, Number(req.params.productId)]);
    res.json(await loadCart(req.userId));
  } catch (err) {
    next(err);
  }
});

export default router;
