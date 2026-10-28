/**
 * @file app.js
 * @description Express application construction without server startup or schema mutation.
 */
import express from 'express';
import cors from 'cors';
import { assertSchemaReady } from './db.js';
import productsRouter from './routes/products.js';
import authRouter from './routes/auth.js';
import cartRouter from './routes/cart.js';
import contactRouter from './routes/contact.js';
import ordersRouter from './routes/orders.js';
import geographyRouter from './routes/geography.js';
import paymentsRouter from './routes/payments.js';
import paymongoWebhookRouter from './routes/paymongo-webhook.js';
import addressesRouter from './routes/addresses.js';
import favoritesRouter from './routes/favorites.js';
import preferencesRouter from './routes/preferences.js';
import notificationsRouter from './routes/notifications.js';
import verificationRouter from './routes/verification.js';
import vouchersRouter from './routes/vouchers.js';
import adminRouter from './routes/admin.js';
import liveRouter from './routes/live.js';
import trackingRouter from './routes/tracking.js';
import { ordersReviewsRouter, productReviewsRouter } from './routes/reviews.js';
import { corsOptions } from './cors-config.js';

export function livenessHandler(_req, res) {
  return res.json({ ok: true });
}

export function readinessHandler(readiness) {
  return async (_req, res) => {
    try {
      await readiness();
      return res.json({ ok: true });
    } catch {
      return res.status(503).json({ ok: false });
    }
  };
}

/** Builds the API while preserving raw PayMongo webhook verification before JSON parsing. */
export function createApp({ env = process.env, readiness = assertSchemaReady } = {}) {
  const app = express();
  app.use(cors(corsOptions(env)));
  app.get('/api/health/live', livenessHandler);
  app.get('/api/health/ready', readinessHandler(readiness));
  app.get('/api/health', readinessHandler(readiness));

  app.use('/api/webhooks/paymongo', express.raw({ type: 'application/json', limit: '256kb' }), paymongoWebhookRouter);
  app.use(express.json({ limit: '1mb' }));
  app.use('/api/products', productReviewsRouter);
  app.use('/api/products', productsRouter);
  app.use('/api/auth', authRouter);
  app.use('/api/cart', cartRouter);
  app.use('/api/contact', contactRouter);
  app.use('/api/orders', ordersRouter);
  app.use('/api/orders', trackingRouter);
  app.use('/api/orders', ordersReviewsRouter);
  app.use('/api/geography', geographyRouter);
  app.use('/api/payments', paymentsRouter);
  app.use('/api/addresses', addressesRouter);
  app.use('/api/favorites', favoritesRouter);
  app.use('/api/preferences', preferencesRouter);
  app.use('/api/notifications', notificationsRouter);
  app.use('/api/verification', verificationRouter);
  app.use('/api/vouchers', vouchersRouter);
  app.use('/api/admin', adminRouter);
  app.use('/api/live', liveRouter);
  app.use('/api', (_req, res) => res.status(404).json({ message: 'Endpoint not found.' }));

  app.use((err, _req, res, _next) => {
    if (err.type === 'entity.parse.failed') {
      return res.status(400).json({ message: 'Request body must be valid JSON.' });
    }
    const status = err.status || 500;
    if (status >= 500) console.error(`[api] Request failed (${err.name || 'Error'}).`);
    return res.status(status).json({
      message: status >= 500 && !err.status ? 'Something went wrong on our side. Please try again.' : err.message,
    });
  });
  return app;
}
