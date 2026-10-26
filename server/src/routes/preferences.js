/**
 * @file preferences.js
 * @description Authenticated persisted accessibility preferences.
 */
import { Router } from 'express';
import { requireAuth } from '../auth.js';
import { query } from '../db.js';

// reduceMotion and largerText are the required accessibility settings. notifyOrderUpdates is
// an optional notification preference: callers that omit it keep their saved value.
const REQUIRED_FIELDS = new Set(['reduceMotion', 'largerText']);
const OPTIONAL_FIELDS = new Set(['notifyOrderUpdates']);
const DEFAULTS = { reduceMotion: false, largerText: false, notifyOrderUpdates: true };

function validatePreferences(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { message: 'Choose valid accessibility settings.' };
  }
  const unknown = Object.keys(body).find((field) => !REQUIRED_FIELDS.has(field) && !OPTIONAL_FIELDS.has(field));
  if (unknown) return { message: `Unknown preference field: ${unknown}.` };
  for (const field of REQUIRED_FIELDS) {
    if (!(field in body)) return { message: 'Both accessibility settings are required.' };
  }
  if (typeof body.reduceMotion !== 'boolean' || typeof body.largerText !== 'boolean') {
    return { message: 'Accessibility settings must be on or off.' };
  }
  if ('notifyOrderUpdates' in body && typeof body.notifyOrderUpdates !== 'boolean') {
    return { message: 'Notification settings must be on or off.' };
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
                notify_order_updates AS "notifyOrderUpdates", updated_at AS "updatedAt"
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
      // notifyOrderUpdates is optional: when omitted ($4 is null) keep the existing value
      // on update, or fall back to the column default (true) on first insert.
      const notifyParam = 'notifyOrderUpdates' in req.body ? req.body.notifyOrderUpdates : null;
      const { rows } = await dbQuery(
        `INSERT INTO user_preferences (user_id, reduce_motion, larger_text, notify_order_updates)
         VALUES ($1, $2, $3, COALESCE($4, true))
         ON CONFLICT (user_id) DO UPDATE SET
           reduce_motion = EXCLUDED.reduce_motion,
           larger_text = EXCLUDED.larger_text,
           notify_order_updates = COALESCE($4, user_preferences.notify_order_updates),
           updated_at = now()
         RETURNING reduce_motion AS "reduceMotion", larger_text AS "largerText",
                   notify_order_updates AS "notifyOrderUpdates", updated_at AS "updatedAt"`,
        [req.userId, req.body.reduceMotion, req.body.largerText, notifyParam],
      );
      res.json(rows[0]);
    } catch (error) {
      next(error);
    }
  });

  return router;
}

export default createPreferencesRouter();
