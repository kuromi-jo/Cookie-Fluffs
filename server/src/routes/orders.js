/**
 * @file orders.js
 * @description Authenticated order placement and confirmation retrieval.
 */
import { Router } from 'express';
import { pool } from '../db.js';
import { requireAuth } from '../auth.js';
import { createOrder, getOrderByPublicId } from '../order-service.js';
import { orderRequestFingerprint, validateOrderRequest } from '../order-validation.js';

const PUBLIC_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function createOrdersRouter(dbPool = pool, orderActions = { createOrder, getOrderByPublicId }) {
  const router = Router();
  router.use(requireAuth);

  router.post('/', async (req, res, next) => {
    const validation = validateOrderRequest(req.body);
    if (Object.keys(validation.errors).length) {
      const message = Object.values(validation.errors)[0];
      return res.status(400).json({ message, errors: validation.errors });
    }

    if (!dbPool) {
      const error = new Error('Database is not connected yet.');
      error.status = 503;
      return next(error);
    }
    const client = await dbPool.connect().catch(next);
    if (!client) return undefined;
    try {
      const result = await orderActions.createOrder(
        client,
        req.userId,
        validation.value,
        orderRequestFingerprint(validation.value),
      );
      return res.status(result.created ? 201 : 200).json(result.order);
    } catch (error) {
      return next(error);
    } finally {
      client.release();
    }
  });

  router.get('/:id', async (req, res, next) => {
    if (!PUBLIC_ID_RE.test(req.params.id)) return res.status(404).json({ message: 'Order not found.' });
    if (!dbPool) {
      const error = new Error('Database is not connected yet.');
      error.status = 503;
      return next(error);
    }
    const client = await dbPool.connect().catch(next);
    if (!client) return undefined;
    try {
      const order = await orderActions.getOrderByPublicId(client, req.userId, req.params.id.toLowerCase());
      if (!order) return res.status(404).json({ message: 'Order not found.' });
      return res.json(order);
    } catch (error) {
      return next(error);
    } finally {
      client.release();
    }
  });

  return router;
}

export default createOrdersRouter();
