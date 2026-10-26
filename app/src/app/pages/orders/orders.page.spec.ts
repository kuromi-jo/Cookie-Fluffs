/**
 * @file orders.page.spec.ts
 * @description Order-history status labeling regression tests.
 */
import { signal } from '@angular/core';
import { describe, expect, it, vi } from 'vitest';
import { OrdersPage } from './orders.page';
import { OrderSummary } from '../../core/models';

const order = (overrides: Partial<OrderSummary> = {}): OrderSummary => ({
  id: '123e4567-e89b-42d3-a456-426614174000',
  fulfillmentMethod: 'delivery',
  paymentMethod: 'gcash',
  paymentStatus: 'awaiting_payment',
  paymentIsDemo: false,
  orderStatus: 'placed',
  itemNames: ['Classic Choco Chip'],
  itemCount: 2,
  thumbnailUrls: ['assets/cookies/choco-chip.webp'],
  total: 500,
  currency: 'PHP',
  createdAt: '2026-10-24T00:00:00.000Z',
  ...overrides,
});

describe('My Orders labels', () => {
  it('keeps genuine and simulated payment states distinct', () => {
    const page = Object.create(OrdersPage.prototype) as OrdersPage;
    expect(page.paymentStatusLabel(order({ paymentStatus: 'paid' }))).toBe('Paid');
    expect(page.paymentStatusLabel(order({ paymentIsDemo: true, demoPaymentStatus: 'demo_approved' })))
      .toBe('Test approved');
    expect(page.paymentStatusLabel(order({ paymentIsDemo: true, demoPaymentStatus: 'demo_cancelled' })))
      .toBe('Test cancelled');
  });

  it('summarizes products and uses the persisted fulfillment state', () => {
    const page = Object.create(OrdersPage.prototype) as OrdersPage;
    expect(page.itemNames(order({ itemNames: ['Classic Choco Chip', 'Ube Cheesecake', 'S’mores'] })))
      .toBe('Classic Choco Chip, Ube Cheesecake +1 more');
    expect(page.orderStatusLabel(order({ orderStatus: 'out_for_delivery' }))).toBe('Out for delivery');
    expect(page.orderStatusLabel(order({ fulfillmentMethod: 'pickup', orderStatus: 'ready' }))).toBe('Ready for pickup');
  });

  it('shows customer-safe refund review labels', () => {
    const page = Object.create(OrdersPage.prototype) as OrdersPage;
    expect(page.refundStatusLabel(order({ refundStatus: 'review_required' }))).toBe('Refund review');
    expect(page.refundStatusLabel(order({ refundStatus: 'approved' }))).toBe('Refund approved');
    expect(page.refundStatusLabel(order({ refundStatus: 'refunded' }))).toBe('Refunded');
    expect(page.refundStatusLabel(order())).toBe('');
  });

  it('blocks reorder offline without calling the API', async () => {
    const page = Object.create(OrdersPage.prototype) as OrdersPage;
    const reorderApi = vi.fn();
    Object.assign(page as object, {
      products: { online: signal(false) },
      ordersApi: { reorder: reorderApi },
      cart: { replaceFromServer: vi.fn() },
      reorderingId: signal(''),
      reorderOrderId: signal(''),
      reorderResult: signal(null),
      reorderError: signal(''),
    });
    await page.reorder(order());
    expect(reorderApi).not.toHaveBeenCalled();
    expect(page.reorderError()).toContain('Reconnect');
  });

  it('applies the authoritative reordered cart and keeps partial results visible', async () => {
    const page = Object.create(OrdersPage.prototype) as OrdersPage;
    const cart = { items: [], boxes: [], itemCount: 2, selectedCount: 2, subtotal: 200, deliveryFee: 49, freeDeliveryMin: 500, total: 249 };
    const result = {
      cart,
      added: [{ lineType: 'single' as const, displayName: 'Classic Choco Chip', quantity: 2 }],
      unavailable: [{ displayName: 'Old Cookie', reason: 'No longer available.', quantity: 1 }],
      replayed: false,
    };
    const replaceFromServer = vi.fn();
    Object.assign(page as object, {
      products: { online: signal(true) },
      ordersApi: { reorder: vi.fn().mockResolvedValue(result) },
      cart: { replaceFromServer },
      reorderingId: signal(''),
      reorderOrderId: signal(''),
      reorderResult: signal(null),
      reorderError: signal(''),
    });
    await page.reorder(order());
    expect(replaceFromServer).toHaveBeenCalledWith(cart);
    expect(page.reorderResult()).toEqual(result);
  });
});
