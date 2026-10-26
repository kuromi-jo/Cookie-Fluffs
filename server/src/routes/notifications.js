/**
 * @file notifications.js
 * @description Authenticated, owner-scoped in-app notification reads and read-state updates.
 */
import { Router } from 'express';
import { requireAuth } from '../auth.js';
import { query } from '../db.js';
import {
  listNotifications,
  unreadCount,
  markNotificationRead,
  markAllNotificationsRead,
} from '../notification-service.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function createNotificationsRouter(dbQuery = query) {
  const router = Router();
  router.use(requireAuth);

  // GET /api/notifications?limit&cursor — owner-scoped, bounded keyset pagination.
  router.get('/', async (req, res, next) => {
    try {
      const limit = req.query.limit !== undefined ? Number(req.query.limit) : undefined;
      const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : undefined;
      const page = await listNotifications(dbQuery, req.userId, {
        limit: Number.isFinite(limit) ? Math.trunc(limit) : undefined,
        cursor,
      });
      res.json(page);
    } catch (error) {
      next(error);
    }
  });

  // GET /api/notifications/unread-count
  router.get('/unread-count', async (req, res, next) => {
    try {
      res.json({ count: await unreadCount(dbQuery, req.userId) });
    } catch (error) {
      next(error);
    }
  });

  // POST /api/notifications/read-all
  router.post('/read-all', async (req, res, next) => {
    try {
      if (req.body && typeof req.body === 'object' && Object.keys(req.body).length) {
        return res.status(400).json({ message: 'This request must not include a body.' });
      }
      const updated = await markAllNotificationsRead(dbQuery, req.userId);
      return res.json({ updated });
    } catch (error) {
      return next(error);
    }
  });

  // POST /api/notifications/:id/read
  router.post('/:id/read', async (req, res, next) => {
    try {
      if (!UUID_RE.test(req.params.id)) return res.status(404).json({ message: 'Notification not found.' });
      if (req.body && typeof req.body === 'object' && Object.keys(req.body).length) {
        return res.status(400).json({ message: 'This request must not include a body.' });
      }
      const ok = await markNotificationRead(dbQuery, req.userId, req.params.id.toLowerCase());
      if (!ok) return res.status(404).json({ message: 'Notification not found.' });
      return res.status(204).end();
    } catch (error) {
      return next(error);
    }
  });

  return router;
}

export default createNotificationsRouter();
