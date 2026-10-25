/**
 * @file checkout.page.spec.ts
 * @description Checkout payment-mode routing tests for genuine and simulated wallets.
 */
import { describe, expect, it } from 'vitest';
import { PaymentConfig } from '../../core/models';
import {
  agreementAcceptedAfterReview,
  checkoutRefreshFailure,
  clearSavedAddressDraft,
  fulfillmentCapabilityError,
  isGenuineWalletMethod,
  shouldApplyDefaultAddress,
  shouldClearSavedAddressDraft,
} from './checkout.page';
import { CheckoutConfig } from '../../core/checkout-config';
import { CheckoutFormValue, buildOrderDetails } from '../../core/checkout-rules';

const config = (demo: boolean): PaymentConfig => ({
  onlineEnabled: true,
  mode: 'test',
  publicKey: 'pk_test_public',
  methods: [
    { id: 'gcash', label: 'GCash', available: true, unavailableMessage: '', demo },
    { id: 'maya', label: 'Maya', available: true, unavailableMessage: '', demo },
    { id: 'card', label: 'Card', available: true, unavailableMessage: '', demo: true },
  ],
  unavailableMessage: '',
});

describe('checkout wallet authorization mode', () => {
  it('uses the popup path only for available genuine wallets', () => {
    expect(isGenuineWalletMethod(config(false), 'gcash')).toBe(true);
    expect(isGenuineWalletMethod(config(false), 'maya')).toBe(true);
    expect(isGenuineWalletMethod(config(false), 'card')).toBe(false);
  });

  it('preserves the in-app wallet demo path', () => {
    expect(isGenuineWalletMethod(config(true), 'gcash')).toBe(false);
    expect(isGenuineWalletMethod(config(true), 'maya')).toBe(false);
  });
});

describe('checkout agreement review', () => {
  it('accepts only an explicit confirmation during the initial review', () => {
    expect(agreementAcceptedAfterReview(false, 'confirm', false)).toBe(true);
    expect(agreementAcceptedAfterReview(false, 'cancel', false)).toBe(false);
  });

  it('preserves an existing acceptance when policy links are reviewed and closed', () => {
    expect(agreementAcceptedAfterReview(true, 'cancel', true)).toBe(true);
  });

  it('does not carry an unchecked agreement through a dismissed policy review', () => {
    expect(agreementAcceptedAfterReview(false, undefined, true)).toBe(false);
  });
});

describe('server-owned fulfillment capabilities', () => {
  const checkoutConfig: CheckoutConfig = {
    nonProductionDemo: false,
    delivery: { enabled: true, unavailableMessage: '', allowedCityCodes: ['1381300000'] },
    pickup: { enabled: false, unavailableMessage: 'Pickup is not configured.', location: '', hours: '' },
    voucher: { enabled: false, unavailableMessage: '' },
    agreement: { required: true, version: 'configured-version' },
    pricing: { currency: 'PHP', deliveryFee: 49, freeDeliveryMinimum: 500 },
  };

  it('allows only backend-enabled methods and covered cities', () => {
    expect(fulfillmentCapabilityError(checkoutConfig, {
      fulfillmentMethod: 'delivery', cityCode: '1381300000',
    })).toBeNull();
    expect(fulfillmentCapabilityError(checkoutConfig, {
      fulfillmentMethod: 'delivery', cityCode: '1374040000',
    })).toMatch(/selected city/i);
    expect(fulfillmentCapabilityError(checkoutConfig, {
      fulfillmentMethod: 'pickup', cityCode: '',
    })).toMatch(/not configured/i);
  });
});

describe('checkout review refresh', () => {
  it('reports missing selected items before order creation', () => {
    expect(checkoutRefreshFailure(0, 'reviewed', 'fresh')).toMatchObject({ reason: 'cart-unavailable' });
  });

  it('requires another review when the selected cart changes', () => {
    expect(checkoutRefreshFailure(1, 'reviewed', 'fresh')).toMatchObject({ reason: 'cart-changed' });
  });

  it('continues only when selected items still match the review', () => {
    expect(checkoutRefreshFailure(1, 'same', 'same')).toBeNull();
  });
});

describe('saved-address switching', () => {
  const savedDraft: CheckoutFormValue = {
    fulfillmentMethod: 'delivery',
    paymentMethod: 'gcash',
    contactName: 'Saved Recipient',
    contactPhone: '+639181234567',
    addressLine1: '88 Saved Street',
    addressLine2: 'Unit 4',
    regionCode: '1300000000',
    region: 'National Capital Region (NCR)',
    cityCode: '1381300000',
    city: 'Quezon City',
    barangayCode: '1381300001',
    barangay: 'Alicia',
    province: 'Metro Manila',
    postalCode: '1100',
    notes: 'Pack the cookies carefully.',
  };

  it('clears copied address values while restoring account contact defaults', () => {
    const manual = clearSavedAddressDraft(savedDraft, {
      contactName: 'Account Customer',
      contactPhone: '+639171234567',
    });
    expect(manual).toMatchObject({
      contactName: 'Account Customer',
      contactPhone: '+639171234567',
      addressLine1: '',
      addressLine2: '',
      cityCode: '',
      city: '',
      barangayCode: '',
      barangay: '',
      postalCode: '',
      paymentMethod: 'gcash',
      notes: 'Pack the cookies carefully.',
    });
  });

  it('preserves an explicitly replaced contact and excludes stale address values from the payload', () => {
    const manual = clearSavedAddressDraft(savedDraft, {
      contactName: 'Alternate Recipient',
      contactPhone: '09191234567',
    });
    const payload = buildOrderDetails(manual);
    expect(payload).toMatchObject({ contactName: 'Alternate Recipient', contactPhone: '+639191234567' });
    expect(payload.deliveryAddress).toMatchObject({
      addressLine1: '', cityCode: '', barangayCode: '', postalCode: '',
    });
    expect(JSON.stringify(payload)).not.toContain('88 Saved Street');
    expect(JSON.stringify(payload)).not.toContain('Alicia');
  });

  it('does not apply a delayed default response after manual entry was selected', () => {
    const manual = clearSavedAddressDraft(savedDraft, {
      contactName: 'Account Customer',
      contactPhone: '+639171234567',
    });
    expect(shouldApplyDefaultAddress(true, true, manual, new Set())).toBe(false);
    expect(shouldApplyDefaultAddress(false, false, manual, new Set())).toBe(true);
  });

  it('keeps manual edits when the already-selected manual option is tapped again', () => {
    expect(shouldClearSavedAddressDraft(null, true)).toBe(false);
    expect(shouldClearSavedAddressDraft('saved-address-id', true)).toBe(true);
  });
});
