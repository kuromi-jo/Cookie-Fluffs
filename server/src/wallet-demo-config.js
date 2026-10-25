/**
 * @file wallet-demo-config.js
 * @description Explicit nonproduction switch and public capabilities for wallet demonstrations.
 */
export function walletDemoConfig(env = process.env) {
  const appEnv = env.APP_ENV?.trim().toLowerCase();
  const production = appEnv === 'production';
  return {
    enabled: env.WALLET_DEMO_ENABLED?.trim().toLowerCase() === 'true' && ['demo', 'test'].includes(appEnv),
    production,
  };
}

export function addWalletDemoCapabilities(paymentConfig, demoConfig = walletDemoConfig()) {
  if (!demoConfig.enabled) return { ...paymentConfig, walletDemoEnabled: false };
  const walletIds = new Set(['gcash', 'maya']);
  const methods = paymentConfig.methods
    .filter((method) => !walletIds.has(method.id))
    .concat([
      { id: 'gcash', label: 'GCash', available: true, unavailableMessage: '', demo: true, demoKind: 'wallet' },
      { id: 'maya', label: 'Maya', available: true, unavailableMessage: '', demo: true, demoKind: 'wallet' },
    ]);
  return {
    ...paymentConfig,
    onlineEnabled: true,
    mode: 'test',
    methods,
    walletDemoEnabled: true,
    walletDemoNotice: 'Test wallet payment only. Do not enter wallet credentials. No money will be transferred.',
  };
}
