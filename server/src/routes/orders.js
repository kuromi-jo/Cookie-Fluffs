/**
 * @file orders.js
 * @description Authenticated order placement and confirmation retrieval.
 */
import { Router } from 'express';
import { pool } from '../db.js';
import { requireAuth } from '../auth.js';
import { createOrder, getOrderByPublicId, listOrders } from '../order-service.js';
import { orderRequestFingerprint, validateOrderRequest } from '../order-validation.js';
import { createOrReusePaymentIntent, createOrReusePaymentSession } from '../payment-service.js';
import { PaymongoAdapter } from '../paymongo.js';
import { paymongoConfig } from '../payment-config.js';
import { demoPaymentConfig } from '../demo-payment-config.js';
import { processDemoCard } from '../demo-payment-service.js';
import { walletDemoConfig } from '../wallet-demo-config.js';
import { processDemoWallet } from '../wallet-demo-service.js';
import { requestOrderCancellation } from '../order-lifecycle.js';
import { fulfillmentConfig, fulfillmentError } from '../fulfillment-config.js';
import { reorderOrder } from '../reorder-service.js';

const PUBLIC_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UUID_RE = PUBLIC_ID_RE;

export function createOrdersRouter(
  dbPool = pool,
  orderActions = {
    createOrder,
    getOrderByPublicId,
    listOrders,
    createOrReusePaymentIntent,
    createOrReusePaymentSession,
    processDemoCard,
    processDemoWallet,
    requestOrderCancellation,
    reorderOrder,
  },
  paymentAdapter = new PaymongoAdapter(paymongoConfig()),
  cardDemoConfig = demoPaymentConfig(),
  walletConfig = walletDemoConfig(),
  checkoutConfig = fulfillmentConfig(),
  authenticate = requireAuth,
) {
  const router = Router();
  router.use(authenticate);

  router.post('/', async (req, res, next) => {
    const validation = validateOrderRequest(req.body, {
      agreementRequired: checkoutConfig.agreement.required,
      agreementVersion: checkoutConfig.agreement.version,
    });
    if (Object.keys(validation.errors).length) {
      const message = Object.values(validation.errors)[0];
      return res.status(400).json({ message, errors: validation.errors });
    }
    const readinessError = fulfillmentError(checkoutConfig, validation.value);
    if (readinessError) return res.status(409).json({ message: readinessError });
    const walletMethod = ['gcash', 'maya'].includes(validation.value.paymentMethod);
    const cardUnavailable = validation.value.paymentMethod === 'card' && !cardDemoConfig.enabled;
    if (cardUnavailable || (walletMethod && !walletConfig.enabled && (!paymentAdapter.config?.enabled
      || !paymentAdapter.config.methods.some((method) => method.id === validation.value.paymentMethod)))) {
      return res.status(409).json({ message: 'That online payment method is not available. Choose cash or another enabled method.' });
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
        { paymentIsDemo: validation.value.paymentMethod === 'card' || (walletMethod && walletConfig.enabled) },
      );
      return res.status(result.created ? 201 : 200).json(result.order);
    } catch (error) {
      return next(error);
    } finally {
      client.release();
    }
  });

  router.get('/config', (_req, res) => res.json(checkoutConfig));

  router.get('/', async (req, res, next) => {
    const limitText = req.query?.limit;
    const limit = limitText == null ? 10 : Number(limitText);
    const cursor = typeof req.query?.cursor === 'string' ? req.query.cursor : null;
    if (!Number.isInteger(limit) || limit < 1 || limit > 25 || (req.query?.cursor != null && !cursor)) {
      return res.status(400).json({ message: 'Choose an order history page size from 1 to 25.' });
    }
    if (!dbPool) return res.status(503).json({ message: 'Order history is temporarily unavailable.' });
    const client = await dbPool.connect().catch(next);
    if (!client) return undefined;
    try {
      const result = await orderActions.listOrders(client, req.userId, { limit, cursor });
      return res.json(result);
    } catch (error) {
      return next(error);
    } finally {
      client.release();
    }
  });

  router.post('/:id/reorder', async (req, res, next) => {
    if (!PUBLIC_ID_RE.test(req.params.id)) return res.status(404).json({ message: 'Order not found.' });
    const idempotencyKey = typeof req.body?.idempotencyKey === 'string' ? req.body.idempotencyKey.toLowerCase() : '';
    if (!UUID_RE.test(idempotencyKey) || Object.keys(req.body ?? {}).some((field) => field !== 'idempotencyKey')) {
      return res.status(400).json({ message: 'Send a valid reorder idempotency key.' });
    }
    if (!dbPool) return res.status(503).json({ message: 'Reorder is temporarily unavailable.' });
    const client = await dbPool.connect().catch(next);
    if (!client) return undefined;
    try {
      const result = await orderActions.reorderOrder(
        client,
        req.userId,
        req.params.id.toLowerCase(),
        idempotencyKey,
      );
      return res.json(result);
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

  router.post('/:id/cancellation-requests', async (req, res, next) => {
    if (!PUBLIC_ID_RE.test(req.params.id)) return res.status(404).json({ message: 'Order not found.' });
    const idempotencyKey = typeof req.body?.idempotencyKey === 'string' ? req.body.idempotencyKey.toLowerCase() : '';
    if (!UUID_RE.test(idempotencyKey) || Object.keys(req.body ?? {}).some((field) => field !== 'idempotencyKey')) {
      return res.status(400).json({ message: 'Send a valid cancellation idempotency key.' });
    }
    if (!dbPool) return res.status(503).json({ message: 'Order cancellation is temporarily unavailable.' });
    const client = await dbPool.connect().catch(next);
    if (!client) return undefined;
    try {
      await orderActions.requestOrderCancellation(
        client,
        req.userId,
        req.params.id.toLowerCase(),
        idempotencyKey,
      );
      const order = await orderActions.getOrderByPublicId(client, req.userId, req.params.id.toLowerCase());
      return res.json(order);
    } catch (error) {
      return next(error);
    } finally {
      client.release();
    }
  });

  router.post('/:id/payment-session', async (req, res, next) => {
    if (!PUBLIC_ID_RE.test(req.params.id)) return res.status(404).json({ message: 'Order not found.' });
    const idempotencyKey = typeof req.body?.idempotencyKey === 'string' ? req.body.idempotencyKey.toLowerCase() : '';
    if (!UUID_RE.test(idempotencyKey) || Object.keys(req.body ?? {}).some((field) => field !== 'idempotencyKey')) {
      return res.status(400).json({ message: 'Send a valid payment idempotency key.' });
    }
    if (!dbPool) return res.status(503).json({ message: 'Online payment is temporarily unavailable.' });
    const client = await dbPool.connect().catch(next);
    if (!client) return undefined;
    try {
      const payment = await orderActions.createOrReusePaymentSession(
        client,
        req.userId,
        req.params.id.toLowerCase(),
        idempotencyKey,
        paymentAdapter,
      );
      return res.json(payment);
    } catch (error) {
      return next(error);
    } finally {
      client.release();
    }
  });

  router.post('/:id/payment-intent', async (req, res, next) => {
    if (!PUBLIC_ID_RE.test(req.params.id)) return res.status(404).json({ message: 'Order not found.' });
    const idempotencyKey = typeof req.body?.idempotencyKey === 'string' ? req.body.idempotencyKey.toLowerCase() : '';
    if (!UUID_RE.test(idempotencyKey) || Object.keys(req.body ?? {}).some((field) => field !== 'idempotencyKey')) {
      return res.status(400).json({ message: 'Send a valid payment idempotency key.' });
    }
    if (!paymentAdapter.config?.enabled) return res.status(503).json({ message: 'Online payment is temporarily unavailable.' });
    if (!dbPool) return res.status(503).json({ message: 'Online payment is temporarily unavailable.' });
    const client = await dbPool.connect().catch(next);
    if (!client) return undefined;
    try {
      const payment = await orderActions.createOrReusePaymentIntent(
        client, req.userId, req.params.id.toLowerCase(), idempotencyKey, paymentAdapter,
      );
      return res.json(payment);
    } catch (error) {
      if (error.status === 410 && error.code === 'PAYMENT_ATTEMPT_FAILED') {
        return res.status(410).json({ message: error.message, code: error.code });
      }
      return next(error);
    } finally {
      client.release();
    }
  });

  router.post('/:id/demo-card', async (req, res, next) => {
    if (!PUBLIC_ID_RE.test(req.params.id)) return res.status(404).json({ message: 'Order not found.' });
    if (!cardDemoConfig.enabled || cardDemoConfig.production) {
      return res.status(404).json({ message: 'Card demo is unavailable.' });
    }
    const idempotencyKey = typeof req.body?.idempotencyKey === 'string' ? req.body.idempotencyKey.toLowerCase() : '';
    const scenario = typeof req.body?.scenario === 'string' ? req.body.scenario : '';
    if (!UUID_RE.test(idempotencyKey)
      || !['visa_approved', 'mastercard_declined'].includes(scenario)
      || Object.keys(req.body ?? {}).some((field) => !['idempotencyKey', 'scenario'].includes(field))) {
      return res.status(400).json({ message: 'Send a valid demo scenario and idempotency key.' });
    }
    if (!dbPool) return res.status(503).json({ message: 'Card demo is temporarily unavailable.' });
    const client = await dbPool.connect().catch(next);
    if (!client) return undefined;
    try {
      const result = await orderActions.processDemoCard(
        client,
        req.userId,
        req.params.id.toLowerCase(),
        idempotencyKey,
        scenario,
        cardDemoConfig,
      );
      return res.json(result);
    } catch (error) {
      return next(error);
    } finally {
      client.release();
    }
  });

  router.post('/:id/demo-wallet', async (req, res, next) => {
    if (!PUBLIC_ID_RE.test(req.params.id)) return res.status(404).json({ message: 'Order not found.' });
    if (!walletConfig.enabled || walletConfig.production) {
      return res.status(404).json({ message: 'Wallet demo is unavailable.' });
    }
    const idempotencyKey = typeof req.body?.idempotencyKey === 'string' ? req.body.idempotencyKey.toLowerCase() : '';
    const action = typeof req.body?.action === 'string' ? req.body.action : '';
    if (!UUID_RE.test(idempotencyKey)
      || !['confirm', 'cancel'].includes(action)
      || Object.keys(req.body ?? {}).some((field) => !['idempotencyKey', 'action'].includes(field))) {
      return res.status(400).json({ message: 'Send a valid wallet demo action and idempotency key.' });
    }
    if (!dbPool) return res.status(503).json({ message: 'Wallet demo is temporarily unavailable.' });
    const client = await dbPool.connect().catch(next);
    if (!client) return undefined;
    try {
      const result = await orderActions.processDemoWallet(
        client,
        req.userId,
        req.params.id.toLowerCase(),
        idempotencyKey,
        action,
        walletConfig,
      );
      return res.json(result);
    } catch (error) {
      return next(error);
    } finally {
      client.release();
    }
  });

  return router;
}

export default createOrdersRouter();
