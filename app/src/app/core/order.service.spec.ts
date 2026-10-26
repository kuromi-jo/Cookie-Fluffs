/**
 * @file order.service.spec.ts
 * @description Durable checkout-attempt idempotency and recovery tests.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Order, OrderDetails } from './models';
import {
  CheckoutAttemptStore,
  OrderService,
  PendingCheckoutError,
  paymentPopupFeatures,
  trustedAuthorizationUrl,
  trustedCheckoutUrl,
} from './order.service';

class MemoryStorage {
  data = new Map<string, string>();
  getItem(key: string): string | null { return this.data.get(key) ?? null; }
  setItem(key: string, value: string): void { this.data.set(key, value); }
  removeItem(key: string): void { this.data.delete(key); }
}

const details = (notes = ''): OrderDetails => ({
  fulfillmentMethod: 'pickup',
  paymentMethod: 'cash_on_pickup',
  schedulingMode: 'asap',
  contactName: 'Maria Santos',
  contactPhone: '+639171234567',
  deliveryAddress: null,
  notes,
});

const fingerprint = async (value: OrderDetails) => `hash-${value.notes}`;

describe('checkout attempt storage', () => {
  it('generates one key for one logical attempt', async () => {
    let count = 0;
    const store = new CheckoutAttemptStore(new MemoryStorage(), () => `key-${++count}`, fingerprint);
    const first = await store.prepare(details(), 'cart-a');
    const retry = await store.prepare(details(), 'cart-a');
    expect(retry.idempotencyKey).toBe(first.idempotencyKey);
    expect(count).toBe(1);
  });

  it('preserves the original payload for an exact retry', async () => {
    const store = new CheckoutAttemptStore(new MemoryStorage(), () => 'key-1', fingerprint);
    await store.prepare(details('Leave at reception'), 'cart-a');
    expect(store.readPending()).toMatchObject({ idempotencyKey: 'key-1', payload: details('Leave at reception') });
  });

  it('refuses to reuse a key for changed checkout details', async () => {
    const store = new CheckoutAttemptStore(new MemoryStorage(), () => 'key-1', fingerprint);
    await store.prepare(details(), 'cart-a');
    await expect(store.prepare(details('Changed'), 'cart-a')).rejects.toBeInstanceOf(PendingCheckoutError);
  });

  it('refuses an unsafe replay after the reviewed cart changes', async () => {
    const store = new CheckoutAttemptStore(new MemoryStorage(), () => 'key-1', fingerprint);
    await store.prepare(details(), 'cart-a');
    await expect(store.prepare(details(), 'cart-b')).rejects.toBeInstanceOf(PendingCheckoutError);
  });

  it('survives a browser restart through the same storage', async () => {
    const storage = new MemoryStorage();
    await new CheckoutAttemptStore(storage, () => 'key-1', fingerprint).prepare(details(), 'cart-a');
    const restored = new CheckoutAttemptStore(storage, () => 'key-2', fingerprint).readPending();
    expect(restored).toMatchObject({ idempotencyKey: 'key-1', cartSignature: 'cart-a' });
  });

  it('stores no JWT, password, or payment credential fields', async () => {
    const storage = new MemoryStorage();
    await new CheckoutAttemptStore(storage, () => 'key-1', fingerprint).prepare(details(), 'cart-a');
    const stored = [...storage.data.values()][0];
    expect(stored).not.toMatch(/jwt|password|cardNumber|cvv/i);
  });

  it('removes the retry payload after success', async () => {
    const storage = new MemoryStorage();
    const store = new CheckoutAttemptStore(storage, () => 'key-1', fingerprint);
    const attempt = await store.prepare(details(), 'cart-a');
    store.complete(attempt, 'order-1');
    expect(store.readPending()).toBeNull();
    expect([...storage.data.values()][0]).not.toContain('contactName');
  });

  it('clears an attempt only after a known failure', async () => {
    const store = new CheckoutAttemptStore(new MemoryStorage(), () => 'key-1', fingerprint);
    const attempt = await store.prepare(details(), 'cart-a');
    store.clearKnownFailure(attempt);
    expect(store.readPending()).toBeNull();
  });

  it('uses a new key after a known failure and changed payload', async () => {
    let count = 0;
    const store = new CheckoutAttemptStore(new MemoryStorage(), () => `key-${++count}`, fingerprint);
    const first = await store.prepare(details(), 'cart-a');
    store.clearKnownFailure(first);
    const next = await store.prepare(details('Corrected'), 'cart-a');
    expect(next.idempotencyKey).toBe('key-2');
  });
});

describe('order confirmation API', () => {
  let service: OrderService;
  let http: HttpTestingController;
  let browserStorage: MemoryStorage;

  beforeEach(() => {
    browserStorage = new MemoryStorage();
    vi.stubGlobal('localStorage', browserStorage);
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
    service = TestBed.inject(OrderService);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    http.verify();
    vi.unstubAllGlobals();
  });

  it('reloads an owned confirmation with GET and never submits again', async () => {
    const response = { id: '123e4567-e89b-42d3-a456-426614174000', total: 469 } as Order;
    const result = service.get(response.id);
    const request = http.expectOne(`/api/orders/${response.id}`);
    expect(request.request.method).toBe('GET');
    request.flush(response);
    await expect(result).resolves.toEqual(response);
  });

  it('loads bounded cursor-based order history', async () => {
    const result = service.list(10, 'next-page');
    const request = http.expectOne('/api/orders?limit=10&cursor=next-page');
    expect(request.request.method).toBe('GET');
    request.flush({ orders: [], nextCursor: null });
    await expect(result).resolves.toEqual({ orders: [], nextCursor: null });
  });

  it('reuses one reorder key after an ambiguous failure and clears it after success', async () => {
    const orderId = '123e4567-e89b-42d3-a456-426614174000';
    const first = service.reorder(orderId);
    const firstRequest = http.expectOne(`/api/orders/${orderId}/reorder`);
    const firstKey = firstRequest.request.body.idempotencyKey;
    firstRequest.flush({ message: 'Unavailable' }, { status: 503, statusText: 'Unavailable' });
    await expect(first).rejects.toBeTruthy();

    const retry = service.reorder(orderId);
    const retryRequest = http.expectOne(`/api/orders/${orderId}/reorder`);
    expect(retryRequest.request.body.idempotencyKey).toBe(firstKey);
    retryRequest.flush({
      cart: { items: [], boxes: [], itemCount: 0, selectedCount: 0, subtotal: 0, deliveryFee: 49, freeDeliveryMin: 500, total: 49 },
      added: [],
      unavailable: [],
      replayed: true,
    });
    await expect(retry).resolves.toMatchObject({ replayed: true });

    const next = service.reorder(orderId);
    const nextRequest = http.expectOne(`/api/orders/${orderId}/reorder`);
    expect(nextRequest.request.body.idempotencyKey).not.toBe(firstKey);
    nextRequest.flush({
      cart: { items: [], boxes: [], itemCount: 0, selectedCount: 0, subtotal: 0, deliveryFee: 49, freeDeliveryMin: 500, total: 49 },
      added: [],
      unavailable: [],
      replayed: false,
    });
    await next;
  });

  it('reuses one non-sensitive cancellation key for repeated taps', async () => {
    const orderId = '123e4567-e89b-42d3-a456-426614174000';
    const response = { id: orderId, orderStatus: 'cancelled' } as Order;
    const first = service.requestCancellation(orderId);
    const firstRequest = http.expectOne(`/api/orders/${orderId}/cancellation-requests`);
    expect(firstRequest.request.body).toEqual({ idempotencyKey: expect.any(String) });
    const key = firstRequest.request.body.idempotencyKey;
    firstRequest.flush(response);
    await first;
    const repeated = service.requestCancellation(orderId);
    const repeatedRequest = http.expectOne(`/api/orders/${orderId}/cancellation-requests`);
    expect(repeatedRequest.request.body).toEqual({ idempotencyKey: key });
    repeatedRequest.flush(response);
    await repeated;
    expect(localStorage.getItem('cf.order-cancellation-attempt')).not.toMatch(/token|password|credential/i);
  });

  it('rotates the cancellation key only for an explicit retry after decline', async () => {
    const orderId = '123e4567-e89b-42d3-a456-426614174000';
    const first = service.requestCancellation(orderId);
    const firstRequest = http.expectOne(`/api/orders/${orderId}/cancellation-requests`);
    const firstKey = firstRequest.request.body.idempotencyKey;
    firstRequest.flush({ id: orderId, orderStatus: 'preparing' });
    await first;
    const retry = service.requestCancellation(orderId, true);
    const retryRequest = http.expectOne(`/api/orders/${orderId}/cancellation-requests`);
    expect(retryRequest.request.body.idempotencyKey).not.toBe(firstKey);
    retryRequest.flush({ id: orderId, orderStatus: 'preparing' });
    await retry;
  });

  it('loads customer-safe payment capabilities', async () => {
    const result = service.paymentConfig();
    const request = http.expectOne('/api/payments/config');
    expect(request.request.method).toBe('GET');
    request.flush({ onlineEnabled: false, mode: 'disabled', methods: [], unavailableMessage: 'Not configured.' });
    await expect(result).resolves.toMatchObject({ onlineEnabled: false });
  });

  it('loads authenticated server-owned checkout capabilities', async () => {
    const result = service.checkoutConfig();
    const request = http.expectOne('/api/orders/config');
    expect(request.request.method).toBe('GET');
    request.flush({
      nonProductionDemo: false,
      delivery: { enabled: false, unavailableMessage: 'Not configured.', allowedCityCodes: [] },
      pickup: { enabled: false, unavailableMessage: 'Not configured.', location: '', hours: '' },
      agreement: { required: false, version: null },
      pricing: { currency: 'PHP', deliveryFee: 49, freeDeliveryMinimum: 500 },
    });
    await expect(result).resolves.toMatchObject({ delivery: { enabled: false } });
  });

  it('sends only a scenario and durable idempotency key for the card demo', async () => {
    const orderId = '123e4567-e89b-42d3-a456-426614174000';
    const first = service.submitDemoCard(orderId, 'visa_approved');
    const firstRequest = http.expectOne(`/api/orders/${orderId}/demo-card`);
    expect(firstRequest.request.body).toEqual({
      idempotencyKey: expect.any(String),
      scenario: 'visa_approved',
    });
    expect(JSON.stringify(firstRequest.request.body)).not.toMatch(/cardholder|number|expiry|cvc|pan/i);
    const key = firstRequest.request.body.idempotencyKey;
    firstRequest.flush({ attemptId: 'demo-1', scenario: 'visa_approved', status: 'demo_approved', isDemo: true });
    await first;

    const retry = service.submitDemoCard(orderId, 'visa_approved');
    const retryRequest = http.expectOne(`/api/orders/${orderId}/demo-card`);
    expect(retryRequest.request.body.idempotencyKey).toBe(key);
    retryRequest.flush({ attemptId: 'demo-1', scenario: 'visa_approved', status: 'demo_approved', isDemo: true });
    await retry;
    expect(localStorage.getItem('cf.demo-payment-attempt')).not.toMatch(/cardholder|number|expiry|cvc|pan/i);
  });

  it('sends only an action and durable idempotency key for the wallet demo', async () => {
    const orderId = '123e4567-e89b-42d3-a456-426614174000';
    const first = service.submitDemoWallet(orderId, 'cancel');
    const firstRequest = http.expectOne(`/api/orders/${orderId}/demo-wallet`);
    expect(firstRequest.request.body).toEqual({ idempotencyKey: expect.any(String), action: 'cancel' });
    expect(JSON.stringify(firstRequest.request.body)).not.toMatch(/walletMethod|amount|currency|pin|otp|credential/i);
    const key = firstRequest.request.body.idempotencyKey;
    firstRequest.flush({ attemptId: 'wallet-1', walletMethod: 'gcash', status: 'demo_cancelled', isDemo: true });
    await first;

    const replay = service.submitDemoWallet(orderId, 'cancel');
    const replayRequest = http.expectOne(`/api/orders/${orderId}/demo-wallet`);
    expect(replayRequest.request.body.idempotencyKey).toBe(key);
    replayRequest.flush({ attemptId: 'wallet-1', walletMethod: 'gcash', status: 'demo_cancelled', isDemo: true });
    await replay;
  });

  it('rotates the key only after the server confirms the session expired', async () => {
    const orderId = '123e4567-e89b-42d3-a456-426614174000';
    const result = service.createPaymentSession(orderId);
    const first = http.expectOne(`/api/orders/${orderId}/payment-session`);
    const firstKey = first.request.body.idempotencyKey;
    first.flush({ message: 'Expired.' }, { status: 410, statusText: 'Gone' });
    await new Promise((resolve) => setTimeout(resolve));
    const retry = http.expectOne(`/api/orders/${orderId}/payment-session`);
    expect(retry.request.body.idempotencyKey).not.toBe(firstKey);
    retry.flush({
      attemptId: 'attempt-2',
      checkoutUrl: 'https://checkout.paymongo.com/cs_replacement',
      status: 'active',
    });
    await expect(result).resolves.toMatchObject({ attemptId: 'attempt-2' });
  });

  it('rotates the Payment Intent key only after an explicit confirmed-failure response', async () => {
    const orderId = '123e4567-e89b-42d3-a456-426614174000';
    const result = service.createPaymentIntent(orderId);
    const first = http.expectOne(`/api/orders/${orderId}/payment-intent`);
    const firstKey = first.request.body.idempotencyKey;
    first.flush(
      { message: 'This payment attempt failed.', code: 'PAYMENT_ATTEMPT_FAILED' },
      { status: 410, statusText: 'Gone' },
    );
    await new Promise((resolve) => setTimeout(resolve));
    const retry = http.expectOne(`/api/orders/${orderId}/payment-intent`);
    expect(retry.request.body.idempotencyKey).not.toBe(firstKey);
    retry.flush({
      flow: 'payment_intent', attemptId: 'attempt-2', paymentIntentId: 'pi_retry',
      clientKey: 'client_retry', status: 'awaiting_payment_method',
    });
    await expect(result).resolves.toMatchObject({ attemptId: 'attempt-2', paymentIntentId: 'pi_retry' });
  });

  it('does not rotate the Payment Intent key for an unclassified 410 response', async () => {
    const orderId = '123e4567-e89b-42d3-a456-426614174000';
    const result = service.createPaymentIntent(orderId);
    const request = http.expectOne(`/api/orders/${orderId}/payment-intent`);
    request.flush({ message: 'Unavailable.' }, { status: 410, statusText: 'Gone' });
    await expect(result).rejects.toMatchObject({ status: 410 });
  });

  it('opens one reusable same-origin popup for an order', () => {
    const assign = vi.fn();
    const popup = {
      closed: false,
      close: vi.fn(),
      focus: vi.fn(),
      location: { assign },
    } as unknown as Window;
    const open = vi.spyOn(window, 'open').mockReturnValue(popup);

    expect(service.openPaymentPopup('order-123')).toBe(popup);
    expect(service.openPaymentPopup('order-123')).toBe(popup);
    expect(open).toHaveBeenCalledOnce();
    expect(open).toHaveBeenCalledWith(
      '/payment-authorization/order-123',
      'cookie-fluffs-payment-order-12',
      expect.stringMatching(/^popup=yes,width=480,height=720,left=\d+,top=\d+,resizable=yes,scrollbars=yes$/),
    );
    expect(popup.focus).toHaveBeenCalled();
  });

  it('centers the requested popup within the current desktop window', () => {
    const browser = {
      outerWidth: 1440,
      outerHeight: 900,
      screenX: 100,
      screenY: 40,
      screen: { availWidth: 1440, availHeight: 900 },
    } as Window;
    expect(paymentPopupFeatures(browser))
      .toBe('popup=yes,width=480,height=720,left=580,top=130,resizable=yes,scrollbars=yes');
  });

  it('reports a blocked popup without starting payment', () => {
    vi.spyOn(window, 'open').mockReturnValue(null);
    expect(service.openPaymentPopup('order-123')).toBeNull();
    http.expectNone((request) => request.url.includes('payment-intent'));
  });

  it('replaces a checkout placeholder with a failure before attempting to close it', () => {
    const replace = vi.fn();
    const close = vi.fn();
    const popup = {
      closed: false,
      close,
      focus: vi.fn(),
      location: { replace },
    } as unknown as Window;
    vi.spyOn(window, 'open').mockReturnValue(popup);
    service.openPaymentPopup();

    service.failPaymentPopup(popup, 'order-failed');

    expect(replace).toHaveBeenCalledWith('/payment-authorization?checkoutFailure=order-failed');
    expect(close).toHaveBeenCalledOnce();
    http.expectNone((request) => request.url.includes('payment-intent'));
  });

  it('uses desktop popups only for a wide fine-pointer browser', () => {
    const desktop = { innerWidth: 1200, matchMedia: () => ({ matches: true }) } as unknown as Window;
    const mobile = { innerWidth: 430, matchMedia: () => ({ matches: true }) } as unknown as Window;
    const touch = { innerWidth: 1200, matchMedia: () => ({ matches: false }) } as unknown as Window;
    expect(service.supportsDesktopPaymentPopup(desktop)).toBe(true);
    expect(service.supportsDesktopPaymentPopup(mobile)).toBe(false);
    expect(service.supportsDesktopPaymentPopup(touch)).toBe(false);
  });

  it('polls the authenticated order endpoint until webhook-confirmed Paid', async () => {
    vi.useFakeTimers();
    const statuses: string[] = [];
    const timeout = vi.fn();
    service.pollPaymentStatus('order-123', {
      onOrder: (order) => statuses.push(order.paymentStatus),
      onTimeout: timeout,
      onError: () => false,
      shouldContinue: () => true,
    }, 10, 3);

    await vi.advanceTimersByTimeAsync(10);
    http.expectOne('/api/orders/order-123').flush({ id: 'order-123', paymentStatus: 'awaiting_payment' });
    await vi.advanceTimersByTimeAsync(10);
    http.expectOne('/api/orders/order-123').flush({ id: 'order-123', paymentStatus: 'paid' });
    await vi.runAllTimersAsync();

    expect(statuses).toEqual(['awaiting_payment', 'paid']);
    expect(timeout).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('stops bounded polling on timeout and supports cleanup', async () => {
    vi.useFakeTimers();
    const timeout = vi.fn();
    const stop = service.pollPaymentStatus('order-123', {
      onOrder: vi.fn(),
      onTimeout: timeout,
      onError: () => false,
      shouldContinue: () => true,
    }, 10, 1);
    await vi.advanceTimersByTimeAsync(10);
    http.expectOne('/api/orders/order-123').flush({ id: 'order-123', paymentStatus: 'awaiting_payment' });
    await vi.runAllTimersAsync();
    expect(timeout).toHaveBeenCalledOnce();
    stop();
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });

  it('polls fulfillment until a terminal server status and then stops', async () => {
    vi.useFakeTimers();
    const statuses: string[] = [];
    service.pollOrderLifecycle('order-123', {
      onOrder: (order) => statuses.push(order.orderStatus),
      onTimeout: vi.fn(),
      onError: () => false,
      shouldContinue: () => true,
    }, 10, 3);
    await vi.advanceTimersByTimeAsync(10);
    http.expectOne('/api/orders/order-123').flush({ id: 'order-123', orderStatus: 'preparing' });
    await vi.advanceTimersByTimeAsync(10);
    http.expectOne('/api/orders/order-123').flush({ id: 'order-123', orderStatus: 'completed' });
    await vi.runAllTimersAsync();
    expect(statuses).toEqual(['preparing', 'completed']);
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });

  it('sends wallet details directly to PayMongo without JWT or card fields', async () => {
    const providerFetch = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: { id: 'pm_test' } }) } as Response)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: { id: 'pi_test', attributes: {
        livemode: false, status: 'awaiting_payment_method',
      } } }) } as Response);
    const order = { id: '123e4567-e89b-42d3-a456-426614174000', paymentMethod: 'gcash' } as Order;
    const returnUrl = `${window.location.origin}/payment-authorization/${order.id}?payment=return`;
    const result = service.startIntegratedPayment(order, {
      onlineEnabled: true, mode: 'test', publicKey: 'pk_test_public',
      methods: [{ id: 'gcash', label: 'GCash', available: true, unavailableMessage: '' }], unavailableMessage: '',
    }, { returnUrl });
    const intent = http.expectOne(`/api/orders/${order.id}/payment-intent`);
    intent.flush({ flow: 'payment_intent', attemptId: 'attempt', paymentIntentId: 'pi_test', clientKey: 'client_test', status: 'active' });
    await expect(result).rejects.toThrow(/not completed/);
    const requests = providerFetch.mock.calls.map((call) => JSON.stringify(call));
    expect(requests.join(' ')).not.toMatch(/Bearer|card_number|cvc|sk_test_/i);
    expect(requests[0]).toContain('payment_methods');
    expect(requests[1]).toContain('/payment_intents/pi_test/attach');
    expect(requests[1]).toContain(returnUrl);
    providerFetch.mockRestore();
  });
});

describe('hosted checkout URL validation', () => {
  it('accepts only the official HTTPS checkout host', () => {
    expect(trustedCheckoutUrl('https://checkout.paymongo.com/cs_test')).toBe(true);
    expect(trustedCheckoutUrl('http://checkout.paymongo.com/cs_test')).toBe(false);
    expect(trustedCheckoutUrl('https://checkout.paymongo.com.evil.test/cs_test')).toBe(false);
  });

  it('accepts only credential-free HTTPS authorization URLs', () => {
    expect(trustedAuthorizationUrl('https://payments.example.test/authorize')).toBe(true);
    expect(trustedAuthorizationUrl('http://payments.example.test/authorize')).toBe(false);
    expect(trustedAuthorizationUrl('https://user:pass@payments.example.test/authorize')).toBe(false);
  });
});
