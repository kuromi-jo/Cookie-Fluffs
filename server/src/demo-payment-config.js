/**
 * @file demo-payment-config.js
 * @description Explicit nonproduction switch for the financially isolated card demo.
 */
export function demoPaymentConfig(env = process.env) {
  const production = env.NODE_ENV?.trim().toLowerCase() === 'production';
  return {
    enabled: env.CARD_DEMO_ENABLED?.trim().toLowerCase() === 'true' && !production,
    production,
  };
}

export function addDemoCardCapability(paymentConfig, demoConfig = demoPaymentConfig()) {
  if (!demoConfig.enabled) return { ...paymentConfig, cardDemoEnabled: false };
  const methods = paymentConfig.methods.filter((method) => method.id !== 'card');
  methods.push({
    id: 'card',
    label: 'Credit / Debit Card',
    available: true,
    unavailableMessage: '',
    demo: true,
  });
  return {
    ...paymentConfig,
    onlineEnabled: true,
    mode: 'test',
    methods,
    cardDemoEnabled: true,
    cardDemoNotice: 'DEMO MODE — No real payment will be processed.',
  };
}
