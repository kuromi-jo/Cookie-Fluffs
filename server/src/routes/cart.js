/**
 * @file cart.js
 * @description The logged-in user's cart, stored in Neon.
 * A cart holds single cookies (cart_items) and mix-and-match boxes of 4, 6 or 12 (cart_boxes).
 * Only ticked (selected) lines count toward the totals and checkout.
 */
import { Router } from 'express';
import { pool } from '../db.js';
import { requireAuth } from '../auth.js';
import { lockUserCart } from '../cart-lock.js';
import { loadCart } from '../cart-service.js';
import { BOX_DISCOUNTS } from '../pricing.js';
import { availableSql } from '../season.js';

export { BOX_DISCOUNTS } from '../pricing.js';

const router = Router();
router.use(requireAuth);

const MAX_QTY = 99;

const httpError = (status, message) => Object.assign(new Error(message), { status });

/** Runs one cart write and its response snapshot under the same lock as checkout. */
async function mutateCart(userId, mutate) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await lockUserCart(client, userId);
    await mutate(client);
    const cart = await loadCart(userId, (text, params) => client.query(text, params));
    await client.query('COMMIT');
    return cart;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
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

    const cart = await mutateCart(req.userId, async (client) => {
      const product = await client.query(`SELECT 1 FROM products WHERE id = $1 AND ${availableSql()}`, [productId]);
      if (!product.rowCount) throw httpError(404, 'That cookie is not available.');
      await client.query(
        `INSERT INTO cart_items (user_id, product_id, quantity) VALUES ($1, $2, $3)
         ON CONFLICT (user_id, product_id)
         DO UPDATE SET quantity = LEAST(cart_items.quantity + EXCLUDED.quantity, ${MAX_QTY}), selected = true`,
        [req.userId, productId, qty],
      );
    });
    res.status(201).json(cart);
  } catch (err) {
    next(err);
  }
});

// PATCH /api/cart  { selected }  ticks or unticks everything ("Select all")
router.patch('/', async (req, res, next) => {
  try {
    const selected = parseSelected(req.body.selected);
    const cart = await mutateCart(req.userId, async (client) => {
      await client.query('UPDATE cart_items SET selected = $2 WHERE user_id = $1', [req.userId, selected]);
      await client.query('UPDATE cart_boxes SET selected = $2 WHERE user_id = $1', [req.userId, selected]);
    });
    res.json(cart);
  } catch (err) {
    next(err);
  }
});

// DELETE /api/cart  (empty the whole cart)
router.delete('/', async (req, res, next) => {
  try {
    const cart = await mutateCart(req.userId, async (client) => {
      await client.query('DELETE FROM cart_items WHERE user_id = $1', [req.userId]);
      await client.query('DELETE FROM cart_boxes WHERE user_id = $1', [req.userId]);
    });
    res.json(cart);
  } catch (err) {
    next(err);
  }
});

/* ---------------------------------------------------------------- boxes */

// POST /api/cart/boxes  { size: 4 | 6 | 12, productIds: number[] }  one id per slot, in slot order
router.post('/boxes', async (req, res, next) => {
  try {
    const size = Number(req.body.size);
    const ids = Array.isArray(req.body.productIds) ? req.body.productIds.map(Number) : [];
    if (!Object.hasOwn(BOX_DISCOUNTS, size)) throw httpError(400, 'Boxes come in 4, 6 or 12.');
    if (ids.length !== size) throw httpError(400, `Fill all ${size} spots in your box first.`);

    const cart = await mutateCart(req.userId, async (client) => {
      const unique = [...new Set(ids)];
      const found = await client.query(`SELECT id FROM products WHERE id = ANY($1) AND ${availableSql()}`, [unique]);
      if (found.rowCount !== unique.length) throw httpError(400, 'One of those cookies is no longer available.');
      const box = await client.query('INSERT INTO cart_boxes (user_id, size) VALUES ($1, $2) RETURNING id', [
        req.userId,
        size,
      ]);
      await client.query(
        `INSERT INTO cart_box_items (box_id, slot, product_id)
         SELECT $1, s.slot - 1, s.product_id FROM unnest($2::int[]) WITH ORDINALITY AS s(product_id, slot)`,
        [box.rows[0].id, ids],
      );
    });
    res.status(201).json(cart);
  } catch (err) {
    next(err);
  }
});

// PATCH /api/cart/boxes/:boxId  { quantity?, selected? }  (quantity 0 removes the box)
router.patch('/boxes/:boxId', async (req, res, next) => {
  try {
    const boxId = Number(req.params.boxId);
    const { quantity, selected } = req.body;
    if (quantity === undefined && selected === undefined) throw httpError(400, 'Send a quantity or a selected value.');
    const parsedSelected = selected === undefined ? undefined : parseSelected(selected);
    const qty = quantity === undefined ? undefined : parseQty(quantity);
    const cart = await mutateCart(req.userId, async (client) => {
      if (parsedSelected !== undefined) {
        await client.query('UPDATE cart_boxes SET selected = $3 WHERE user_id = $1 AND id = $2', [
          req.userId,
          boxId,
          parsedSelected,
        ]);
      }
      if (qty !== undefined) {
        if (qty === 0) await client.query('DELETE FROM cart_boxes WHERE user_id = $1 AND id = $2', [req.userId, boxId]);
        else await client.query('UPDATE cart_boxes SET quantity = $3 WHERE user_id = $1 AND id = $2', [req.userId, boxId, qty]);
      }
    });
    res.json(cart);
  } catch (err) {
    next(err);
  }
});

// DELETE /api/cart/boxes/:boxId
router.delete('/boxes/:boxId', async (req, res, next) => {
  try {
    const boxId = Number(req.params.boxId);
    const cart = await mutateCart(req.userId, (client) =>
      client.query('DELETE FROM cart_boxes WHERE user_id = $1 AND id = $2', [req.userId, boxId]));
    res.json(cart);
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
    const parsedSelected = selected === undefined ? undefined : parseSelected(selected);
    const qty = quantity === undefined ? undefined : parseQty(quantity);
    const cart = await mutateCart(req.userId, async (client) => {
      if (parsedSelected !== undefined) {
        await client.query('UPDATE cart_items SET selected = $3 WHERE user_id = $1 AND product_id = $2', [
          req.userId,
          productId,
          parsedSelected,
        ]);
      }
      if (qty !== undefined) {
        if (qty === 0) {
          await client.query('DELETE FROM cart_items WHERE user_id = $1 AND product_id = $2', [req.userId, productId]);
        } else {
          await client.query('UPDATE cart_items SET quantity = $3 WHERE user_id = $1 AND product_id = $2', [req.userId, productId, qty]);
        }
      }
    });
    res.json(cart);
  } catch (err) {
    next(err);
  }
});

// DELETE /api/cart/:productId
router.delete('/:productId', async (req, res, next) => {
  try {
    const productId = Number(req.params.productId);
    const cart = await mutateCart(req.userId, (client) =>
      client.query('DELETE FROM cart_items WHERE user_id = $1 AND product_id = $2', [req.userId, productId]));
    res.json(cart);
  } catch (err) {
    next(err);
  }
});

export default router;
