/**
 * @file favorites.js
 * @description Authenticated, owner-scoped customer favorites.
 */
import { Router } from 'express';
import { availableSql } from '../season.js';
import { requireAuth } from '../auth.js';
import { query } from '../db.js';

const PRODUCT_COLUMNS = `
  p.id, p.slug, p.name, p.tagline, p.description, p.flavor_notes AS "flavorNotes", p.category,
  p.price::float AS price, p.rating::float AS rating, p.reviews_count AS "reviewsCount",
  p.calories, p.allergens, p.badge, p.image_url AS "imageUrl", ${availableSql('p.')} AS "isAvailable",
  p.is_best_seller AS "isBestSeller", p.is_new AS "isNew", p.sale_price::float AS "salePrice"`;

function productId(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

export function createFavoritesRouter(dbQuery = query) {
  const router = Router();
  router.use(requireAuth);

  router.get('/', async (req, res, next) => {
    try {
      const { rows } = await dbQuery(
        `SELECT ${PRODUCT_COLUMNS}, f.created_at AS "favoritedAt"
         FROM user_favorites f
         JOIN products p ON p.id = f.product_id
         WHERE f.user_id = $1
         ORDER BY f.created_at DESC, p.id DESC`,
        [req.userId],
      );
      res.json({ favorites: rows });
    } catch (error) {
      next(error);
    }
  });

  router.put('/:productId', async (req, res, next) => {
    try {
      if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body) || Object.keys(req.body).length) {
        return res.status(400).json({ message: 'Favorite requests must not include extra fields.' });
      }
      const id = productId(req.params.productId);
      if (!id) return res.status(404).json({ message: 'Cookie not found.' });
      const product = await dbQuery('SELECT is_available FROM products WHERE id = $1', [id]);
      if (!product.rowCount) return res.status(404).json({ message: 'Cookie not found.' });
      if (!product.rows[0].is_available) {
        return res.status(409).json({ message: 'That cookie is not currently available to save.' });
      }
      const result = await dbQuery(
        `INSERT INTO user_favorites (user_id, product_id)
         VALUES ($1, $2)
         ON CONFLICT (user_id, product_id) DO NOTHING
         RETURNING created_at AS "favoritedAt"`,
        [req.userId, id],
      );
      res.status(result.rowCount ? 201 : 200).json({ productId: id, saved: true });
    } catch (error) {
      next(error);
    }
  });

  router.delete('/:productId', async (req, res, next) => {
    try {
      const id = productId(req.params.productId);
      if (!id) return res.status(404).json({ message: 'Cookie not found.' });
      await dbQuery('DELETE FROM user_favorites WHERE user_id = $1 AND product_id = $2', [req.userId, id]);
      res.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  return router;
}

export default createFavoritesRouter();
