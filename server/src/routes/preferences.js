/**
 * @file preferences.js
 * @description Authenticated persisted accessibility preferences.
 */
import { Router } from 'express';
import { requireAuth } from '../auth.js';
import { query } from '../db.js';

const ALLOWED_FIELDS = new Set(['reduceMotion', 'largerText']);
const DEFAULTS = { reduceMotion: false, largerText: false };

function validatePreferences(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { message: 'Choose valid accessibility settings.' };
  }
  const unknown = Object.keys(body).find((field) => !ALLOWED_FIELDS.has(field));
  if (unknown) return { message: `Unknown preference field: ${unknown}.` };
  if (Object.keys(body).length !== ALLOWED_FIELDS.size) {
    return { message: 'Both accessibility settings are required.' };
  }
  if (typeof body.reduceMotion !== 'boolean' || typeof body.largerText !== 'boolean') {
    return { message: 'Accessibility settings must be on or off.' };
  }
  return null;
}

export function createPreferencesRouter(dbQuery = query) {
  const router = Router();
  router.use(requireAuth);

  router.get('/', async (req, res, next) => {
    try {
      const { rows } = await dbQuery(
        `SELECT reduce_motion AS "reduceMotion", larger_text AS "largerText",
                updated_at AS "updatedAt"
         FROM user_preferences WHERE user_id = $1`,
        [req.userId],
      );
      res.json(rows[0] ?? { ...DEFAULTS, updatedAt: null });
    } catch (error) {
      next(error);
    }
  });

  router.put('/', async (req, res, next) => {
    try {
      const error = validatePreferences(req.body);
      if (error) return res.status(400).json(error);
      const { rows } = await dbQuery(
        `INSERT INTO user_preferences (user_id, reduce_motion, larger_text)
         VALUES ($1, $2, $3)
         ON CONFLICT (user_id) DO UPDATE SET
           reduce_motion = EXCLUDED.reduce_motion,
           larger_text = EXCLUDED.larger_text,
           updated_at = now()
         RETURNING reduce_motion AS "reduceMotion", larger_text AS "largerText",
                   updated_at AS "updatedAt"`,
        [req.userId, req.body.reduceMotion, req.body.largerText],
      );
      res.json(rows[0]);
    } catch (error) {
      next(error);
    }
  });

  return router;
}

export default createPreferencesRouter();
