/**
 * @file paymongo.js
 * @description Minimal test-mode PayMongo Hosted Checkout v2 adapter.
 */
import { ONLINE_PAYMENT_METHODS, paymongoConfig } from './payment-config.js';
import { moneyToCentavos } from './pricing.js';

const API_URL = 'https://api.paymongo.com/v2/checkout_sessions';
const PAYMENT_INTENTS_URL = 'https://api.paymongo.com/v1/payment_intents';
const CHECKOUT_HOST = 'checkout.paymongo.com';

const providerError = (message, status = 502) => Object.assign(new Error(message), { status });

export function isTrustedCheckoutUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === CHECKOUT_HOST;
  } catch {
    return false;
  }
}

export class PaymongoAdapter {
  constructor(config = paymongoConfig(), fetchImpl = fetch) {
    this.config = config;
    this.fetch = fetchImpl;
  }

  async createCheckoutSession({ attemptId, idempotencyKey, order }) {
    if (!(this.config.hostedEnabled ?? this.config.enabled)) throw providerError(this.config.unavailableMessage, 503);
    const method = ONLINE_PAYMENT_METHODS[order.paymentMethod];
    if (!method || !this.config.methods.some((entry) => entry.id === method.id)) {
      throw providerError('That online payment method is not enabled.', 409);
    }
    let amount;
    try {
      amount = moneyToCentavos(order.total);
    } catch {
      throw providerError('The order total cannot be sent for online payment.', 409);
    }
    if (amount <= 0 || order.currency !== 'PHP') {
      throw providerError('The order total cannot be sent for online payment.', 409);
    }
    const returnBase = `${this.config.appUrl}/order/${encodeURIComponent(order.id)}`;
    const body = {
      data: {
        attributes: {
          line_items: [{ name: `Cookie Fluffs order ${order.id.slice(0, 8).toUpperCase()}`, amount, currency: 'PHP', quantity: 1 }],
          payment_method_types: [method.providerId],
          success_url: `${returnBase}?payment=return`,
          cancel_url: `${returnBase}?payment=cancel`,
          reference_number: order.id,
          send_email_receipt: false,
          pass_on_fees: false,
          metadata: { order_id: order.id, payment_attempt_id: attemptId },
        },
      },
    };
    const response = await this.fetch(API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${this.config.secretKey}:`).toString('base64')}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': idempotencyKey,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) throw providerError('Secure payment could not be prepared. Try again from your order.');
    const sessionId = payload?.data?.id;
    const checkoutUrl = payload?.data?.attributes?.checkout_url;
    if (typeof sessionId !== 'string' || !sessionId.startsWith('cs_') || !isTrustedCheckoutUrl(checkoutUrl)) {
      throw providerError('The payment provider returned an invalid checkout session.');
    }
    if (payload.data.attributes.livemode !== false) {
      throw providerError('Live payment sessions are disabled for this project.');
    }
    return { sessionId, checkoutUrl, status: payload.data.attributes.status ?? 'active' };
  }

  async createPaymentIntent({ attemptId, idempotencyKey, order }) {
    if (!this.config.enabled) throw providerError(this.config.unavailableMessage, 503);
    const method = ONLINE_PAYMENT_METHODS[order.paymentMethod];
    if (!method || method.id === 'card' || !this.config.methods.some((entry) => entry.id === method.id)) {
      throw providerError('That online payment method is not enabled.', 409);
    }
    const amount = moneyToCentavos(order.total);
    const response = await this.fetch(PAYMENT_INTENTS_URL, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${this.config.secretKey}:`).toString('base64')}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': idempotencyKey,
      },
      body: JSON.stringify({ data: { attributes: {
        amount,
        currency: 'PHP',
        payment_method_allowed: [method.providerId],
        description: `Cookie Fluffs order ${order.id.slice(0, 8).toUpperCase()}`,
        metadata: { order_id: order.id, payment_attempt_id: attemptId },
      } } }),
      signal: AbortSignal.timeout(15_000),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) throw providerError('Secure payment could not be prepared. Try again from your order.');
    return this.mapPaymentIntent(payload);
  }

  async retrievePaymentIntent(paymentIntentId) {
    const response = await this.fetch(`${PAYMENT_INTENTS_URL}/${encodeURIComponent(paymentIntentId)}`, {
      headers: { Authorization: `Basic ${Buffer.from(`${this.config.secretKey}:`).toString('base64')}` },
      signal: AbortSignal.timeout(15_000),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) throw providerError('Secure payment status could not be checked. Try again.');
    return this.mapPaymentIntent(payload);
  }

  mapPaymentIntent(payload) {
    const id = payload?.data?.id;
    const attributes = payload?.data?.attributes;
    if (typeof id !== 'string' || !id.startsWith('pi_') || typeof attributes?.client_key !== 'string'
      || attributes?.livemode !== false) {
      throw providerError('The payment provider returned an invalid payment intent.');
    }
    const authorizationUrl = attributes.next_action?.redirect?.url;
    if (authorizationUrl !== undefined && !isTrustedAuthorizationUrl(authorizationUrl)) {
      throw providerError('The payment provider returned an invalid authorization link.');
    }
    const paidPayment = Array.isArray(attributes.payments)
      ? attributes.payments.find((payment) => payment?.attributes?.status === 'paid')
      : null;
    return {
      paymentIntentId: id,
      clientKey: attributes.client_key,
      status: attributes.status,
      ...(authorizationUrl ? { authorizationUrl } : {}),
      ...(paidPayment ? { payment: {
        id: paidPayment.id,
        amount: paidPayment.attributes.amount,
        currency: paidPayment.attributes.currency,
        sourceType: paidPayment.attributes.source?.type,
      } } : {}),
    };
  }
}

export function isTrustedAuthorizationUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password;
  } catch {
    return false;
  }
}
