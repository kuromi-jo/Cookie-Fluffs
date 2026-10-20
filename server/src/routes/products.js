/**
 * @file products.js
 * @description Read-only product catalog endpoints.
 */
import { Router } from 'express';
import { query } from '../db.js';

const router = Router();

const SELECT_PRODUCT = `
  SELECT id, slug, name, tagline, description, flavor_notes AS "flavorNotes", category,
         price::float AS price, rating::float AS rating, reviews_count AS "reviewsCount",
         calories, allergens, badge, image_url AS "imageUrl", is_available AS "isAvailable",
         is_best_seller AS "isBestSeller", is_new AS "isNew", sale_price::float AS "salePrice"
  FROM products`;

/** Home-screen collections: ?collection=best | new | promo */
const COLLECTIONS = {
  best: 'is_best_seller',
  new: 'is_new',
  promo: 'sale_price IS NOT NULL',
};

// GET /api/products?category=fruity&search=choco&collection=promo
router.get('/', async (req, res, next) => {
  try {
    const { category, search, collection } = req.query;
    const where = ['is_available = true'];
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
    const { rows } = await query(`${SELECT_PRODUCT} WHERE ${where.join(' AND ')} ORDER BY id`, params);
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// GET /api/products/:id
router.get('/:id', async (req, res, next) => {
  try {
    const { rows } = await query(`${SELECT_PRODUCT} WHERE id = $1`, [Number(req.params.id)]);
    if (!rows.length) return res.status(404).json({ message: 'Cookie not found.' });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

export default router;
