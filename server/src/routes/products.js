/**
 * @file products.js
 * @description Read-only product catalog endpoints.
 */
import { Router } from 'express';
import { query } from '../db.js';
import { availableSql } from '../season.js';
import { BEST_SELLERS_CTE } from '../best-sellers.js';

const router = Router();

// Best sellers come from real orders (shared with the admin dashboard), not a manual flag.
const SELECT_PRODUCT = `
  WITH ${BEST_SELLERS_CTE}
  SELECT products.id, slug, name, tagline, description, flavor_notes AS "flavorNotes", category,
         price::float AS price, rating::float AS rating, reviews_count AS "reviewsCount",
         calories, allergens, badge, image_url AS "imageUrl", ${availableSql()} AS "isAvailable",
         (best.id IS NOT NULL) AS "isBestSeller", best.rank AS "bestRank",
         is_new AS "isNew", sale_price::float AS "salePrice", season
  FROM products LEFT JOIN best ON best.id = products.id`;

/** Home-screen collections: ?collection=best | new | promo | halloween */
const COLLECTIONS = {
  best: 'best.id IS NOT NULL',
  new: 'is_new',
  promo: 'sale_price IS NOT NULL',
  halloween: "season = 'halloween'",
};

// GET /api/products?category=fruity&search=choco&collection=promo
router.get('/', async (req, res, next) => {
  try {
    const { category, search, collection } = req.query;
    const where = [availableSql()];
    const params = [];
    if (typeof collection === 'string' && Object.hasOwn(COLLECTIONS, collection)) where.push(COLLECTIONS[collection]);
    if (category && category !== 'all') {
      params.push(category);
      where.push(`category = $${params.length}`);
    }
    if (search) {
      params.push(`%${search}%`);
      where.push(`(name ILIKE $${params.length} OR tagline ILIKE $${params.length} OR flavor_notes ILIKE $${params.length})`);
    }
    const { rows } = await query(`${SELECT_PRODUCT} WHERE ${where.join(' AND ')} ORDER BY products.id`, params);
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// GET /api/products/:id/image  (photos uploaded through the admin dashboard)
router.get('/:id/image', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) return res.status(404).json({ message: 'Photo not found.' });
    const { rows } = await query('SELECT mime_type, data FROM product_images WHERE product_id = $1', [id]);
    if (!rows.length) return res.status(404).json({ message: 'Photo not found.' });
    res.set({ 'Content-Type': rows[0].mime_type, 'Cache-Control': 'public, max-age=31536000, immutable' });
    res.send(rows[0].data);
  } catch (err) {
    if (err?.code === '42P01') return res.status(404).json({ message: 'Photo not found.' }); // table not created yet
    next(err);
  }
});

// GET /api/products/:id
router.get('/:id', async (req, res, next) => {
  try {
    const { rows } = await query(`${SELECT_PRODUCT} WHERE products.id = $1`, [Number(req.params.id)]);
    if (!rows.length) return res.status(404).json({ message: 'Cookie not found.' });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

export default router;
