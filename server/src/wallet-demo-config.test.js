/**
 * @file wallet-demo-config.test.js
 * @description Nonproduction gating and public capability tests for wallet demonstrations.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { addWalletDemoCapabilities, walletDemoConfig } from './wallet-demo-config.js';

test('enables wallet demonstrations only when explicitly nonproduction', () => {
  assert.deepEqual(walletDemoConfig({ WALLET_DEMO_ENABLED: 'true', NODE_ENV: 'development' }), {
    enabled: true,
    production: false,
  });
  assert.equal(walletDemoConfig({ WALLET_DEMO_ENABLED: 'true', NODE_ENV: 'production' }).enabled, false);
  assert.equal(walletDemoConfig({ NODE_ENV: 'test' }).enabled, false);
});

test('publishes demo wallets without exposing configuration secrets', () => {
  const result = addWalletDemoCapabilities({
    onlineEnabled: false,
    mode: 'disabled',
    publicKey: '',
    methods: [{ id: 'gcash', label: 'GCash', available: false, unavailableMessage: 'Unavailable.' }],
    unavailableMessage: 'Unavailable.',
  }, { enabled: true, production: false });
  assert.equal(result.walletDemoEnabled, true);
  assert.deepEqual(result.methods.map(({ id, demoKind }) => ({ id, demoKind })), [
    { id: 'gcash', demoKind: 'wallet' },
    { id: 'maya', demoKind: 'wallet' },
  ]);
  assert.doesNotMatch(JSON.stringify(result), /secret|sk_test_|webhook/i);
});
