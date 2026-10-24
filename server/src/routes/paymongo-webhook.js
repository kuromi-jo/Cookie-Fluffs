/**
 * @file paymongo-webhook.js
 * @description Raw-body PayMongo webhook boundary and reconciliation dispatch.
 */
import crypto from 'node:crypto';
import { Router } from 'express';
import { pool } from '../db.js';
import { paymongoConfig } from '../payment-config.js';
import { parsePaymongoEvent, reconcilePaymongoEvent, verifyPaymongoSignature } from '../payment-webhook.js';

export function createPaymongoWebhookRouter(dbPool = pool, config = paymongoConfig()) {
  const router = Router();
  router.post('/', async (req, res, next) => {
    const rawBody = req.body;
    if (!(config.hostedEnabled ?? config.enabled)
      || !verifyPaymongoSignature(rawBody, req.get('Paymongo-Signature'), config.webhookSecret)) {
      return res.status(401).json({ message: 'Invalid payment notification.' });
    }
    let payload;
    try {
      payload = JSON.parse(rawBody.toString('utf8'));
    } catch {
      return res.status(400).json({ message: 'Invalid payment notification.' });
    }
    if (!dbPool) return res.status(503).json({ message: 'Payment confirmation is temporarily unavailable.' });
    const client = await dbPool.connect().catch(next);
    if (!client) return undefined;
    try {
      const event = parsePaymongoEvent(payload, rawBody);
      const payloadHash = crypto.createHash('sha256').update(rawBody).digest('hex');
      await reconcilePaymongoEvent(client, event, payloadHash);
      return res.status(200).json({ received: true });
    } catch (error) {
      return next(error);
    } finally {
      client.release();
    }
  });
  return router;
}

export default createPaymongoWebhookRouter();
