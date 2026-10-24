/**
 * @file payment-authorization.page.spec.ts
 * @description Eligibility and return-route tests for genuine wallet popup authorization.
 */
import { describe, expect, it } from 'vitest';
import { Order, PaymentConfig } from '../../core/models';
import { canAuthorizeRealWallet, checkoutPopupFailureMessage, popupReturnUrl } from './payment-authorization.page';

const config = {
  methods: [
    { id: 'gcash', label: 'GCash', available: true, unavailableMessage: '' },
    { id: 'maya', label: 'Maya', available: true, unavailableMessage: '' },
  ],
} as PaymentConfig;

const order = (paymentMethod: Order['paymentMethod'], overrides: Partial<Order> = {}) => ({
  id: '123e4567-e89b-42d3-a456-426614174000',
  paymentMethod,
  paymentStatus: 'awaiting_payment',
  paymentIsDemo: false,
  ...overrides,
}) as Order;

describe('payment authorization handoff', () => {
  it('permits genuine GCash and Maya orders only', () => {
    expect(canAuthorizeRealWallet(order('gcash'), config)).toBe(true);
    expect(canAuthorizeRealWallet(order('maya'), config)).toBe(true);
    expect(canAuthorizeRealWallet(order('cash_on_delivery'), config)).toBe(false);
    expect(canAuthorizeRealWallet(order('gcash', { paymentIsDemo: true }), config)).toBe(false);
    expect(canAuthorizeRealWallet(order('maya', { paymentStatus: 'paid' }), config)).toBe(false);
  });

  it('rejects unavailable and demo-marked provider capabilities', () => {
    const unavailable = { ...config, methods: [{ ...config.methods[0], available: false }] };
    const demo = { ...config, methods: [{ ...config.methods[0], demo: true }] };
    expect(canAuthorizeRealWallet(order('gcash'), unavailable)).toBe(false);
    expect(canAuthorizeRealWallet(order('gcash'), demo)).toBe(false);
  });

  it('returns to the same origin and order without provider values', () => {
    const url = popupReturnUrl('https://cookie-fluffs.example', order('gcash').id);
    expect(url).toBe('https://cookie-fluffs.example/payment-authorization/123e4567-e89b-42d3-a456-426614174000?payment=return');
    expect(url).not.toMatch(/client|token|paymongo/i);
  });

  it('shows explicit safe checkout failures instead of an indefinite waiting state', () => {
    expect(checkoutPopupFailureMessage('cart-unavailable')).toContain('cart items changed');
    expect(checkoutPopupFailureMessage('cart-changed')).toContain('Review the updated checkout');
    expect(checkoutPopupFailureMessage('order-failed')).toContain('order could not be placed');
    expect(checkoutPopupFailureMessage('provider-secret')).toBeNull();
  });
});
