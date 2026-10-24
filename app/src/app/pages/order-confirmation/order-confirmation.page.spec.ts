/**
 * @file order-confirmation.page.spec.ts
 * @description Safe customer-facing messages for recoverable online-payment failures.
 */
import { HttpErrorResponse } from '@angular/common/http';
import { describe, expect, it, vi } from 'vitest';
import {
  PaymentReturnRefreshGate,
  cancellationConfirmation,
  orderDocumentTitle,
  paymentRecoveryErrorMessage,
  paymentStatusMessage,
  shouldRefreshPaymentOnReturn,
  shouldPollOrderLifecycle,
} from './order-confirmation.page';
import { Order } from '../../core/models';

const httpError = (status: number, message = '') => new HttpErrorResponse({
  status,
  error: message ? { message } : undefined,
});

describe('payment recovery errors', () => {
  it('distinguishes network and authentication failures', () => {
    expect(paymentRecoveryErrorMessage(httpError(0))).toContain('Check your connection');
    expect(paymentRecoveryErrorMessage(httpError(401))).toContain('Log in again');
  });

  it('asks customers to refresh an already-paid order', () => {
    expect(paymentRecoveryErrorMessage(httpError(409, 'This order is already paid.')))
      .toBe('This order may already be paid. Refresh payment status before trying again.');
  });

  it('explains missing or invalid authorization redirects safely', () => {
    expect(paymentRecoveryErrorMessage(new Error('The wallet authorization link is invalid.')))
      .toBe('The secure payment link is missing or invalid. Refresh payment status before trying again.');
  });

  it('preserves approved provider-rejection guidance without exposing raw responses', () => {
    expect(paymentRecoveryErrorMessage(new Error('Wallet authorization could not be started. Try again.')))
      .toBe('Wallet authorization could not be started. Try again.');
    expect(paymentRecoveryErrorMessage(new Error('provider payload: secret details')))
      .toBe('Secure payment is unavailable right now. Refresh payment status, then try again.');
  });
});

describe('payment status messages', () => {
  it('explains confirmed failure without implying that the order was charged', () => {
    expect(paymentStatusMessage('failed', 'return'))
      .toBe('Secure payment failed. Your order was not charged. You can safely try payment again.');
  });

  it('does not infer failure from a browser return', () => {
    expect(paymentStatusMessage('awaiting_payment', 'return'))
      .toBe('Payment is not confirmed yet. Refresh the status or continue secure payment for this order.');
  });
});

describe('payment return refresh', () => {
  const order = (overrides: Partial<Order> = {}) => ({
    paymentMethod: 'gcash',
    paymentStatus: 'awaiting_payment',
    paymentIsDemo: false,
    ...overrides,
  }) as Order;

  it('refreshes only authenticated, unsettled genuine online orders', () => {
    expect(shouldRefreshPaymentOnReturn(order(), true)).toBe(true);
    expect(shouldRefreshPaymentOnReturn(order(), false)).toBe(false);
    expect(shouldRefreshPaymentOnReturn(order({ paymentStatus: 'paid' }), true)).toBe(false);
    expect(shouldRefreshPaymentOnReturn(order({ paymentIsDemo: true }), true)).toBe(false);
    expect(shouldRefreshPaymentOnReturn(order({ paymentMethod: 'cash_on_delivery' }), true)).toBe(false);
  });

  it('coalesces simultaneous focus and visibility refreshes', async () => {
    let finish!: () => void;
    const task = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    const gate = new PaymentReturnRefreshGate();
    const focused = gate.run(task);
    const visible = gate.run(task);
    expect(focused).toBe(visible);
    await Promise.resolve();
    expect(task).toHaveBeenCalledTimes(1);
    finish();
    await focused;
    const nextTask = vi.fn(async () => undefined);
    await gate.run(nextTask);
    expect(task).toHaveBeenCalledTimes(1);
    expect(nextTask).toHaveBeenCalledTimes(1);
  });
});

describe('fulfillment refresh', () => {
  it('polls active order details but stops for terminal states and confirmation views', () => {
    const order = { orderStatus: 'preparing' } as Order;
    expect(shouldPollOrderLifecycle(order, true)).toBe(true);
    expect(shouldPollOrderLifecycle(order, false)).toBe(false);
    expect(shouldPollOrderLifecycle({ ...order, orderStatus: 'completed' }, true)).toBe(false);
    expect(shouldPollOrderLifecycle({ ...order, orderStatus: 'cancelled' }, true)).toBe(false);
  });
});

describe('cancellation confirmation', () => {
  const order = (overrides: Partial<Order> = {}) => ({
    id: 'ba5b8711-7dac-4e66-84e7-9dde8638a42f',
    paymentStatus: 'awaiting_payment',
    cancellationAction: 'cancel',
    ...overrides,
  }) as Order;

  it('identifies the order and explains paid cancellation without promising a refund', () => {
    const confirmation = cancellationConfirmation(order({ paymentStatus: 'paid' }));
    expect(confirmation.header).toBe('Cancel order #BA5B8711?');
    expect(confirmation.message).toContain('stop fulfillment');
    expect(confirmation.message).toContain('does not automatically issue a refund');
    expect(confirmation.confirmText).toBe('Confirm cancellation');
  });

  it('distinguishes a preparation-stage request from immediate cancellation', () => {
    const confirmation = cancellationConfirmation(order({ cancellationAction: 'request' }));
    expect(confirmation.header).toBe('Request cancellation for #BA5B8711?');
    expect(confirmation.message).toContain('not cancelled unless the request is approved');
    expect(confirmation.confirmText).toBe('Submit request');
  });
});

describe('print document labels', () => {
  const order = (overrides: Partial<Order> = {}): Order => ({
    id: '123e4567-e89b-42d3-a456-426614174000',
    fulfillmentMethod: 'delivery',
    paymentMethod: 'gcash',
    paymentStatus: 'awaiting_payment',
    orderStatus: 'placed',
    events: [],
    historyAvailable: false,
    cancellation: null,
    cancellationAction: 'cancel',
    refund: null,
    schedulingMode: 'asap',
    contactName: 'Sample Customer',
    contactPhone: '+639171234567',
    deliveryAddress: null,
    notes: '',
    merchandiseSubtotal: 100,
    promotionDiscount: 0,
    packDiscount: 0,
    discountTotal: 0,
    deliveryFee: 49,
    total: 149,
    currency: 'PHP',
    createdAt: '2026-10-24T00:00:00.000Z',
    items: [],
    ...overrides,
  });

  it('distinguishes genuine, cash, pending, and demo documents', () => {
    expect(orderDocumentTitle(order({ paymentStatus: 'paid' }))).toBe('Payment Receipt');
    expect(orderDocumentTitle(order())).toBe('Order Summary — Payment Pending');
    expect(orderDocumentTitle(order({ paymentMethod: 'cash_on_delivery', paymentStatus: 'pending_cash' })))
      .toBe('Order Confirmation — Payment Due');
    expect(orderDocumentTitle(order({ paymentIsDemo: true, demoPayment: { scenario: 'visa_approved', status: 'demo_approved', createdAt: '', updatedAt: '' } })))
      .toBe('Demo Receipt — No Real Payment Processed');
    expect(orderDocumentTitle(order({ paymentIsDemo: true, walletDemoPayment: { walletMethod: 'maya', status: 'demo_cancelled', createdAt: '', updatedAt: '' } })))
      .toBe('Unpaid Order Summary');
  });

  it('labels refund review and completion without claiming early settlement', () => {
    const refund = {
      id: '223e4567-e89b-42d3-a456-426614174000',
      paymentMethod: 'gcash' as const,
      originalPaidAmount: 149,
      approvedAmount: null,
      currency: 'PHP' as const,
      status: 'review_required' as const,
      createdAt: '',
      updatedAt: '',
      reviewedAt: null,
      events: [],
    };
    expect(orderDocumentTitle(order({ refund }))).toBe('Cancelled Order — Refund Review');
    expect(orderDocumentTitle(order({ refund: { ...refund, status: 'approved', approvedAmount: 149 } })))
      .toBe('Cancelled Order — Refund Approved for Processing');
    expect(orderDocumentTitle(order({ refund: { ...refund, status: 'refunded', approvedAmount: 149 } })))
      .toBe('Refund Confirmation');
  });
});
