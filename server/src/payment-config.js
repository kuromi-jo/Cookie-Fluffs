/**
 * @file payment-config.js
 * @description Test-only PayMongo configuration and customer-safe capability output.
 */
export const ONLINE_PAYMENT_METHODS = Object.freeze({
  gcash: { id: 'gcash', providerId: 'gcash', label: 'GCash' },
  maya: { id: 'maya', providerId: 'paymaya', label: 'Maya' },
  card: { id: 'card', providerId: 'card', label: 'Credit / Debit Card' },
});

function publicUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))
      ? url.origin
      : '';
  } catch {
    return '';
  }
}

export function paymongoConfig(env = process.env) {
  const secretKey = env.PAYMONGO_SECRET_KEY?.trim() ?? '';
  const publicKey = env.PAYMONGO_PUBLIC_KEY?.trim() ?? '';
  const webhookSecret = env.PAYMONGO_WEBHOOK_SECRET?.trim() ?? '';
  const appUrl = publicUrl(env.APP_PUBLIC_URL?.trim() ?? '');
  const requested = new Set((env.PAYMONGO_ENABLED_METHODS ?? '').split(',').map((value) => value.trim()).filter(Boolean));
  const methods = Object.values(ONLINE_PAYMENT_METHODS).filter((method) => requested.has(method.id));
  const testKey = secretKey.startsWith('sk_test_');
  const testPublicKey = publicKey.startsWith('pk_test_');
  const liveKey = secretKey.startsWith('sk_live_');
  const hostedEnabled = testKey && Boolean(webhookSecret && appUrl && methods.length);
  const enabled = hostedEnabled && testPublicKey && methods.some((method) => method.id !== 'card');

  return {
    enabled,
    hostedEnabled,
    mode: enabled ? 'test' : 'disabled',
    secretKey: hostedEnabled ? secretKey : '',
    publicKey: enabled ? publicKey : '',
    webhookSecret: hostedEnabled ? webhookSecret : '',
    appUrl,
    methods: hostedEnabled ? methods : [],
    unavailableMessage: liveKey
      ? 'Online payment is disabled because this project accepts test credentials only.'
      : 'Online payment is not configured for this class-project environment.',
  };
}

export function publicPaymentConfig(config = paymongoConfig()) {
  return {
    onlineEnabled: config.enabled,
    mode: config.mode,
    publicKey: config.enabled ? config.publicKey : '',
    methods: config.methods.map(({ id, label }) => ({
      id,
      label,
      available: config.enabled && id !== 'card',
      unavailableMessage: id === 'card'
        ? 'Card payment needs a PCI compliance review before it can be enabled.'
        : '',
    })),
    unavailableMessage: config.unavailableMessage,
  };
}
