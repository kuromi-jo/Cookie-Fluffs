/**
 * @file checkout-config.spec.ts
 * @description Checkout capability normalization and fail-closed behavior tests.
 */
import { describe, expect, it } from 'vitest';
import { CLOSED_CHECKOUT_CONFIG, normalizeCheckoutConfig } from './checkout-config';

const response = {
  nonProductionDemo: false,
  delivery: { enabled: true, unavailableMessage: '', allowedCityCodes: ['1381300000'] },
  pickup: { enabled: true, unavailableMessage: '', location: 'Configured public location', hours: 'Configured hours' },
  agreement: { required: true, version: 'configured-version' },
  pricing: { currency: 'PHP', deliveryFee: 49, freeDeliveryMinimum: 500 },
};

describe('checkout capability normalization', () => {
  it('enables only complete server-configured methods', () => {
    expect(normalizeCheckoutConfig(response)).toMatchObject({
      delivery: { enabled: true, allowedCityCodes: ['1381300000'] },
      pickup: { enabled: true, location: 'Configured public location' },
      agreement: { required: true, version: 'configured-version' },
    });
  });

  it('fails closed for missing, malformed, or invalid configuration', () => {
    expect(normalizeCheckoutConfig(null)).toBe(CLOSED_CHECKOUT_CONFIG);
    expect(normalizeCheckoutConfig({ ...response, pricing: { currency: 'USD' } })).toBe(CLOSED_CHECKOUT_CONFIG);
    expect(normalizeCheckoutConfig({ ...response, agreement: { required: true, version: null } }))
      .toBe(CLOSED_CHECKOUT_CONFIG);
  });

  it('does not enable a method whose required business details are absent', () => {
    const config = normalizeCheckoutConfig({
      ...response,
      delivery: { enabled: true, unavailableMessage: '', allowedCityCodes: [] },
      pickup: { enabled: true, unavailableMessage: '', location: '', hours: '' },
    });
    expect(config.delivery.enabled).toBe(false);
    expect(config.pickup.enabled).toBe(false);
  });
});
