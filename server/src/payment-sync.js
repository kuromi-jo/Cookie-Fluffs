/**
 * @file payment-sync.js
 * @description Confirms PayMongo wallet payments without relying only on webhooks. PayMongo cannot reach
 * a localhost API, so when a customer checks an order that is still waiting for payment, the server asks
 * PayMongo (with the secret key) for the payment intent and, if it was paid, records it through the
 * same reconciliation path the webhook uses (same amount/method checks, idempotent, one notification).
 */
import crypto from 'node:crypto';
import { reconcilePaymongoEvent } from './payment-webhook.js';

const MIN_INTERVAL_MS = 4000;
const lastCheck = new Map(); // order public id -> ms

/**
 * @param {import('pg').PoolClient} client
 * @param {number} userId
 * @param {string} orderPublicId
 * @param {{ config?: { enabled?: boolean }, retrievePaymentIntent: (id: string) => Promise<any> }} adapter
 */
export async function syncPendingPayment(client, userId, orderPublicId, adapter) {
  if (!adapter?.config?.enabled) return false;
  const now = Date.now();
  if (now - (lastCheck.get(orderPublicId) ?? 0) < MIN_INTERVAL_MS) return false;
  lastCheck.set(orderPublicId, now);
  if (lastCheck.size > 2000) lastCheck.clear();

  const { rows } = await client.query(
    `SELECT pa.provider_intent_id AS "intentId"
     FROM payment_attempts pa JOIN orders o ON o.id = pa.order_id
     WHERE o.public_id = $1 AND o.user_id = $2 AND o.payment_is_demo IS NOT TRUE
       AND pa.provider_intent_id IS NOT NULL AND pa.status IN ('active', 'processing')
       AND COALESCE(o.payment_state, o.payment_status) NOT IN ('paid', 'refunded')
     ORDER BY pa.id DESC LIMIT 1`,
    [orderPublicId, userId],
  );
  if (!rows.length) return false;

  let intent;
  try {
    intent = await adapter.retrievePaymentIntent(rows[0].intentId);
  } catch {
    return false; // provider unreachable: the order simply stays pending until the next check
  }
  if (intent.status !== 'succeeded' || !intent.payment) return false;

  const { id, amount, currency, sourceType } = intent.payment;
  const event = {
    eventId: `sync_${id}_paid`,
    eventType: 'payment.paid',
    livemode: false,
    session: { id, attributes: { payment_intent_id: intent.paymentIntentId, amount, currency, source: { type: sourceType } } },
  };
  const payloadHash = crypto.createHash('sha256').update(JSON.stringify(event)).digest('hex');
  try {
    await reconcilePaymongoEvent(client, event, payloadHash);
    return true;
  } catch {
    // Mismatch or no longer active (the reconciler already rolled back): leave the order unchanged.
    return false;
  }
}
