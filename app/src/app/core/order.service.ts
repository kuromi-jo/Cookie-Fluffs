/**
 * @file order.service.ts
 * @description Typed order API access with durable, replay-safe checkout attempts.
 */
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { environment } from '../../environments/environment';
import {
  DemoCardScenario,
  DemoPaymentResult,
  Order,
  OrderDetails,
  OrderHistoryPage,
  OrderRequest,
  PaymentConfig,
  PaymentIntentSetup,
  PaymentSession,
  ReorderResult,
  WalletDemoAction,
  WalletDemoResult,
} from './models';
import { canonicalOrderDetails } from './checkout-rules';
import { CheckoutConfig } from './checkout-config';

const ATTEMPT_KEY = 'cf.checkout-attempt';
const PAYMENT_ATTEMPT_KEY = 'cf.payment-attempt';
const DEMO_PAYMENT_ATTEMPT_KEY = 'cf.demo-payment-attempt';
const WALLET_DEMO_ATTEMPT_KEY = 'cf.wallet-demo-attempt';
const CANCELLATION_ATTEMPT_KEY = 'cf.order-cancellation-attempt';
const REORDER_ATTEMPT_KEY = 'cf.order-reorder-attempt';

interface PendingAttempt {
  state: 'pending';
  idempotencyKey: string;
  fingerprint: string;
  cartSignature: string;
  payload: OrderDetails;
  createdAt: string;
}

interface CompletedAttempt {
  state: 'completed';
  idempotencyKey: string;
  fingerprint: string;
  orderId: string;
}

type StoredAttempt = PendingAttempt | CompletedAttempt;

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

type FingerprintFn = (details: OrderDetails) => Promise<string>;

export interface PaymentPollHandlers {
  onOrder: (order: Order) => void;
  onTimeout: () => void;
  onError: (error: unknown) => boolean;
  shouldContinue: () => boolean;
}

export interface IntegratedPaymentOptions {
  returnUrl?: string;
}

const PAYMENT_POPUP_WIDTH = 480;
const PAYMENT_POPUP_HEIGHT = 720;
const PAYMENT_POLL_INTERVAL_MS = 2_000;
const PAYMENT_POLL_LIMIT = 60;
const LIFECYCLE_POLL_INTERVAL_MS = 10_000;
const LIFECYCLE_POLL_LIMIT = 60;

export function paymentPopupFeatures(browser: Window = window): string {
  const outerWidth = browser.outerWidth || browser.screen.availWidth || PAYMENT_POPUP_WIDTH;
  const outerHeight = browser.outerHeight || browser.screen.availHeight || PAYMENT_POPUP_HEIGHT;
  const left = Math.round(browser.screenX + Math.max(0, (outerWidth - PAYMENT_POPUP_WIDTH) / 2));
  const top = Math.round(browser.screenY + Math.max(0, (outerHeight - PAYMENT_POPUP_HEIGHT) / 2));
  return [
    'popup=yes',
    `width=${PAYMENT_POPUP_WIDTH}`,
    `height=${PAYMENT_POPUP_HEIGHT}`,
    `left=${left}`,
    `top=${top}`,
    'resizable=yes',
    'scrollbars=yes',
  ].join(',');
}

export class PendingCheckoutError extends Error {
  constructor(message = 'An earlier order may already have been placed. Retry that order before changing checkout details.') {
    super(message);
  }
}

export class CheckoutAttemptStore {
  private fallback: StoredAttempt | null = null;

  constructor(
    private storage: StorageLike,
    private createUuid: () => string = () => crypto.randomUUID(),
    private fingerprint: FingerprintFn = fingerprintOrderDetails,
  ) {}

  readPending(): PendingAttempt | null {
    const attempt = this.read();
    return attempt?.state === 'pending' ? attempt : null;
  }

  async prepare(details: OrderDetails, cartSignature: string): Promise<PendingAttempt> {
    const fingerprint = await this.fingerprint(details);
    const existing = this.readPending();
    if (existing) {
      if (existing.fingerprint !== fingerprint || existing.cartSignature !== cartSignature) {
        throw new PendingCheckoutError();
      }
      return existing;
    }
    const attempt: PendingAttempt = {
      state: 'pending',
      idempotencyKey: this.createUuid(),
      fingerprint,
      cartSignature,
      payload: details,
      createdAt: new Date().toISOString(),
    };
    this.write(attempt);
    return attempt;
  }

  complete(attempt: PendingAttempt, orderId: string): void {
    this.write({
      state: 'completed',
      idempotencyKey: attempt.idempotencyKey,
      fingerprint: attempt.fingerprint,
      orderId,
    });
  }

  clearKnownFailure(attempt: PendingAttempt): void {
    if (this.readPending()?.idempotencyKey !== attempt.idempotencyKey) return;
    this.fallback = null;
    try {
      this.storage.removeItem(ATTEMPT_KEY);
    } catch {
      /* Storage is unavailable; the in-memory fallback was still cleared. */
    }
  }

  private read(): StoredAttempt | null {
    try {
      const raw = this.storage.getItem(ATTEMPT_KEY);
      if (!raw) return this.fallback;
      const value = JSON.parse(raw) as StoredAttempt;
      if (!value || (value.state !== 'pending' && value.state !== 'completed')) return null;
      return value;
    } catch {
      return this.fallback;
    }
  }

  private write(attempt: StoredAttempt): void {
    this.fallback = attempt;
    try {
      this.storage.setItem(ATTEMPT_KEY, JSON.stringify(attempt));
    } catch {
      /* Retry protection remains active in memory only when storage is unavailable. */
    }
  }
}

@Injectable({ providedIn: 'root' })
export class OrderService {
  private http = inject(HttpClient);
  private base = `${environment.apiUrl}/orders`;
  private attempts = new CheckoutAttemptStore(localStorage);
  private paymentPopup: Window | null = null;
  private paymentPopupOrderId = '';

  pendingAttempt(): PendingAttempt | null {
    return this.attempts.readPending();
  }

  async place(details: OrderDetails, cartSignature: string): Promise<Order> {
    const attempt = await this.attempts.prepare(details, cartSignature);
    return this.send(attempt);
  }

  async retryPending(cartSignature: string, cartIsEmpty = false): Promise<Order> {
    const attempt = this.attempts.readPending();
    if (!attempt) throw new Error('There is no checkout attempt to retry.');
    // An empty cart is safe to probe: replay returns an existing order, while a missing order stays rejected.
    if (attempt.cartSignature !== cartSignature && !cartIsEmpty) {
      throw new PendingCheckoutError(
        'Your selected cart changed after the earlier checkout. Return to the cart and restore those selections, or unselect everything, before retrying the original order.',
      );
    }
    return this.send(attempt);
  }

  get(id: string): Promise<Order> {
    return firstValueFrom(this.http.get<Order>(`${this.base}/${encodeURIComponent(id)}`));
  }

  list(limit = 10, cursor?: string): Promise<OrderHistoryPage> {
    const query = new URLSearchParams({ limit: String(limit) });
    if (cursor) query.set('cursor', cursor);
    return firstValueFrom(this.http.get<OrderHistoryPage>(`${this.base}?${query.toString()}`));
  }

  requestCancellation(orderId: string, rotateAfterDecline = false): Promise<Order> {
    return firstValueFrom(this.http.post<Order>(
      `${this.base}/${encodeURIComponent(orderId)}/cancellation-requests`,
      { idempotencyKey: this.cancellationAttemptKey(orderId, rotateAfterDecline) },
    ));
  }

  async reorder(orderId: string): Promise<ReorderResult> {
    const idempotencyKey = this.reorderAttemptKey(orderId);
    try {
      const result = await firstValueFrom(this.http.post<ReorderResult>(
        `${this.base}/${encodeURIComponent(orderId)}/reorder`,
        { idempotencyKey },
      ));
      this.clearReorderAttemptKey(orderId, idempotencyKey);
      return result;
    } catch (error) {
      if (!(error instanceof HttpErrorResponse) || (error.status !== 0 && error.status < 500)) {
        this.clearReorderAttemptKey(orderId, idempotencyKey);
      }
      throw error;
    }
  }

  paymentConfig(): Promise<PaymentConfig> {
    return firstValueFrom(this.http.get<PaymentConfig>(`${environment.apiUrl}/payments/config`));
  }

  checkoutConfig(): Promise<CheckoutConfig> {
    return firstValueFrom(this.http.get<CheckoutConfig>(`${this.base}/config`));
  }

  submitDemoCard(orderId: string, scenario: DemoCardScenario): Promise<DemoPaymentResult> {
    const idempotencyKey = this.demoPaymentAttemptKey(orderId, scenario);
    return firstValueFrom(this.http.post<DemoPaymentResult>(
      `${this.base}/${encodeURIComponent(orderId)}/demo-card`,
      { idempotencyKey, scenario },
    ));
  }

  submitDemoWallet(orderId: string, action: WalletDemoAction): Promise<WalletDemoResult> {
    const idempotencyKey = this.walletDemoAttemptKey(orderId, action);
    return firstValueFrom(this.http.post<WalletDemoResult>(
      `${this.base}/${encodeURIComponent(orderId)}/demo-wallet`,
      { idempotencyKey, action },
    ));
  }

  async createPaymentSession(orderId: string): Promise<PaymentSession> {
    let idempotencyKey = this.paymentAttemptKey(orderId);
    let session: PaymentSession;
    try {
      session = await this.requestPaymentSession(orderId, idempotencyKey);
    } catch (error) {
      if (!(error instanceof HttpErrorResponse) || error.status !== 410) throw error;
      this.clearPaymentAttemptKey(orderId);
      idempotencyKey = this.paymentAttemptKey(orderId);
      session = await this.requestPaymentSession(orderId, idempotencyKey);
    }
    if (!trustedCheckoutUrl(session.checkoutUrl)) throw new Error('The secure payment link is invalid.');
    return session;
  }

  async createPaymentIntent(orderId: string): Promise<PaymentIntentSetup> {
    let idempotencyKey = this.paymentAttemptKey(orderId);
    try {
      return await this.requestPaymentIntent(orderId, idempotencyKey);
    } catch (error) {
      if (!(error instanceof HttpErrorResponse)
        || error.status !== 410
        || error.error?.code !== 'PAYMENT_ATTEMPT_FAILED') throw error;
      this.clearPaymentAttemptKey(orderId);
      idempotencyKey = this.paymentAttemptKey(orderId);
      return this.requestPaymentIntent(orderId, idempotencyKey);
    }
  }

  supportsDesktopPaymentPopup(browser: Window = window): boolean {
    return browser.innerWidth >= 768 && browser.matchMedia?.('(pointer: fine)').matches === true;
  }

  openPaymentPopup(orderId = ''): Window | null {
    if (this.paymentPopup && !this.paymentPopup.closed
      && (!orderId || !this.paymentPopupOrderId || this.paymentPopupOrderId === orderId)) {
      this.paymentPopup.focus();
      return this.paymentPopup;
    }
    const path = orderId
      ? `/payment-authorization/${encodeURIComponent(orderId)}`
      : '/payment-authorization';
    const popupName = `cookie-fluffs-payment-${orderId ? orderId.slice(0, 8) : 'checkout'}`;
    const popup = window.open(path, popupName, paymentPopupFeatures());
    if (!popup) return null;
    this.paymentPopup = popup;
    this.paymentPopupOrderId = orderId;
    return popup;
  }

  navigatePaymentPopup(popup: Window, orderId: string): boolean {
    if (popup.closed) return false;
    popup.location.assign(`/payment-authorization/${encodeURIComponent(orderId)}`);
    popup.focus();
    this.paymentPopup = popup;
    this.paymentPopupOrderId = orderId;
    return true;
  }

  activePaymentPopup(orderId: string): Window | null {
    return this.paymentPopupOrderId === orderId && this.paymentPopup && !this.paymentPopup.closed
      ? this.paymentPopup
      : null;
  }

  closePaymentPopup(popup: Window | null): void {
    if (popup && !popup.closed) popup.close();
    if (popup === this.paymentPopup) {
      this.paymentPopup = null;
      this.paymentPopupOrderId = '';
    }
  }

  failPaymentPopup(
    popup: Window | null,
    reason: 'cart-unavailable' | 'cart-changed' | 'order-failed',
  ): void {
    if (!popup || popup.closed) return;
    try {
      popup.location.replace(`/payment-authorization?checkoutFailure=${reason}`);
    } catch {
      /* The checkout page still shows the failure if the placeholder cannot be updated. */
    }
    try {
      popup.close();
    } catch {
      /* A browser-managed tab remains on the explicit same-origin failure screen. */
    }
    if (popup.closed && popup === this.paymentPopup) {
      this.paymentPopup = null;
      this.paymentPopupOrderId = '';
    }
  }

  pollPaymentStatus(
    orderId: string,
    handlers: PaymentPollHandlers,
    intervalMs = PAYMENT_POLL_INTERVAL_MS,
    limit = PAYMENT_POLL_LIMIT,
  ): () => void {
    let stopped = false;
    let attempts = 0;
    let timer: number | undefined;
    const stop = () => {
      stopped = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
    const tick = async () => {
      if (stopped || !handlers.shouldContinue()) return stop();
      attempts += 1;
      try {
        const order = await this.get(orderId);
        if (stopped) return;
        handlers.onOrder(order);
        if (order.paymentStatus === 'paid') return stop();
      } catch (error) {
        if (stopped) return;
        if (handlers.onError(error)) return stop();
      }
      if (attempts >= limit) {
        handlers.onTimeout();
        return stop();
      }
      timer = window.setTimeout(tick, intervalMs);
    };
    timer = window.setTimeout(tick, intervalMs);
    return stop;
  }

  pollOrderLifecycle(
    orderId: string,
    handlers: PaymentPollHandlers,
    intervalMs = LIFECYCLE_POLL_INTERVAL_MS,
    limit = LIFECYCLE_POLL_LIMIT,
  ): () => void {
    let stopped = false;
    let attempts = 0;
    let timer: number | undefined;
    const stop = () => {
      stopped = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
    const tick = async () => {
      if (stopped || !handlers.shouldContinue()) return stop();
      attempts += 1;
      try {
        const order = await this.get(orderId);
        if (stopped) return;
        handlers.onOrder(order);
        if (['completed', 'cancelled'].includes(order.orderStatus)) return stop();
      } catch (error) {
        if (stopped) return;
        if (handlers.onError(error)) return stop();
      }
      if (attempts >= limit) {
        handlers.onTimeout();
        return stop();
      }
      timer = window.setTimeout(tick, intervalMs);
    };
    timer = window.setTimeout(tick, intervalMs);
    return stop;
  }

  async startIntegratedPayment(
    order: Order,
    config: PaymentConfig,
    options: IntegratedPaymentOptions = {},
  ): Promise<void> {
    const setup = await this.createPaymentIntent(order.id);
    if (setup.flow === 'hosted_checkout') {
      if (!setup.checkoutUrl || !trustedCheckoutUrl(setup.checkoutUrl)) throw new Error('The secure payment link is invalid.');
      window.location.assign(setup.checkoutUrl);
      return;
    }
    if (!config.publicKey.startsWith('pk_test_') || !setup.paymentIntentId?.startsWith('pi_') || !setup.clientKey) {
      throw new Error('Secure payment is not configured.');
    }
    const defaultReturnUrl = `${window.location.origin}/order/${encodeURIComponent(order.id)}?payment=return`;
    const returnUrl = options.returnUrl ?? defaultReturnUrl;
    if (new URL(returnUrl).origin !== window.location.origin) throw new Error('The payment return link is invalid.');
    if (setup.status === 'awaiting_next_action') {
      if (!trustedAuthorizationUrl(setup.authorizationUrl)) throw new Error('The wallet authorization link is invalid.');
      window.location.assign(setup.authorizationUrl);
      return;
    }
    if (setup.status === 'succeeded' || setup.status === 'processing') {
      window.location.assign(returnUrl);
      return;
    }
    const providerMethod = order.paymentMethod === 'maya' ? 'paymaya' : order.paymentMethod;
    if (providerMethod !== 'gcash' && providerMethod !== 'paymaya') throw new Error('That payment method is unavailable.');
    const authorization = `Basic ${btoa(`${config.publicKey}:`)}`;
    const paymentMethodResponse = await fetch('https://api.paymongo.com/v1/payment_methods', {
      method: 'POST',
      headers: { Authorization: authorization, 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: { attributes: { type: providerMethod } } }),
    });
    const paymentMethodPayload = await paymentMethodResponse.json().catch(() => null);
    const paymentMethodId = paymentMethodPayload?.data?.id;
    if (!paymentMethodResponse.ok || typeof paymentMethodId !== 'string' || !paymentMethodId.startsWith('pm_')) {
      throw new Error('Your wallet could not be prepared. Try again.');
    }
    const attachResponse = await fetch(
      `https://api.paymongo.com/v1/payment_intents/${encodeURIComponent(setup.paymentIntentId)}/attach`,
      {
        method: 'POST',
        headers: { Authorization: authorization, 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: { attributes: {
          payment_method: paymentMethodId,
          client_key: setup.clientKey,
          return_url: returnUrl,
        } } }),
      },
    );
    const attached = await attachResponse.json().catch(() => null);
    const attributes = attached?.data?.attributes;
    if (!attachResponse.ok || attached?.data?.id !== setup.paymentIntentId || attributes?.livemode !== false) {
      throw new Error('Wallet authorization could not be started. Try again.');
    }
    if (attributes.status === 'awaiting_next_action') {
      const url = attributes.next_action?.redirect?.url;
      if (!trustedAuthorizationUrl(url)) throw new Error('The wallet authorization link is invalid.');
      window.location.assign(url);
      return;
    }
    if (attributes.status === 'succeeded' || attributes.status === 'processing') {
      window.location.assign(returnUrl);
      return;
    }
    throw new Error('Wallet authorization was not completed. Try again.');
  }

  private requestPaymentIntent(orderId: string, idempotencyKey: string): Promise<PaymentIntentSetup> {
    return firstValueFrom(this.http.post<PaymentIntentSetup>(
      `${this.base}/${encodeURIComponent(orderId)}/payment-intent`,
      { idempotencyKey },
    ));
  }

  private requestPaymentSession(orderId: string, idempotencyKey: string): Promise<PaymentSession> {
    return firstValueFrom(this.http.post<PaymentSession>(
      `${this.base}/${encodeURIComponent(orderId)}/payment-session`,
      { idempotencyKey },
    ));
  }

  private async send(attempt: PendingAttempt): Promise<Order> {
    const request: OrderRequest = { ...attempt.payload, idempotencyKey: attempt.idempotencyKey };
    try {
      const order = await firstValueFrom(this.http.post<Order>(this.base, request));
      this.attempts.complete(attempt, order.id);
      return order;
    } catch (error) {
      if (!isAmbiguousOrderError(error)) this.attempts.clearKnownFailure(attempt);
      throw error;
    }
  }

  private paymentAttemptKey(orderId: string): string {
    try {
      const stored = JSON.parse(localStorage.getItem(PAYMENT_ATTEMPT_KEY) ?? 'null') as { orderId?: string; idempotencyKey?: string } | null;
      if (stored?.orderId === orderId && typeof stored.idempotencyKey === 'string') return stored.idempotencyKey;
    } catch {
      /* A fresh durable key is safer than trusting malformed storage. */
    }
    const idempotencyKey = crypto.randomUUID();
    try {
      localStorage.setItem(PAYMENT_ATTEMPT_KEY, JSON.stringify({ orderId, idempotencyKey }));
    } catch {
      /* The backend still deduplicates active sessions if local storage is unavailable. */
    }
    return idempotencyKey;
  }

  private clearPaymentAttemptKey(orderId: string): void {
    try {
      const stored = JSON.parse(localStorage.getItem(PAYMENT_ATTEMPT_KEY) ?? 'null') as { orderId?: string } | null;
      if (stored?.orderId === orderId) localStorage.removeItem(PAYMENT_ATTEMPT_KEY);
    } catch {
      try {
        localStorage.removeItem(PAYMENT_ATTEMPT_KEY);
      } catch {
        /* The server still rejects reuse of the confirmed expired key. */
      }
    }
  }

  private demoPaymentAttemptKey(orderId: string, scenario: DemoCardScenario): string {
    try {
      const stored = JSON.parse(localStorage.getItem(DEMO_PAYMENT_ATTEMPT_KEY) ?? 'null') as {
        orderId?: string;
        scenario?: DemoCardScenario;
        idempotencyKey?: string;
      } | null;
      if (stored?.orderId === orderId && stored.scenario === scenario && typeof stored.idempotencyKey === 'string') {
        return stored.idempotencyKey;
      }
    } catch {
      /* A new non-sensitive retry key is safe when storage is malformed. */
    }
    const idempotencyKey = crypto.randomUUID();
    try {
      localStorage.setItem(DEMO_PAYMENT_ATTEMPT_KEY, JSON.stringify({ orderId, scenario, idempotencyKey }));
    } catch {
      /* The backend order lock and uniqueness constraints remain authoritative. */
    }
    return idempotencyKey;
  }

  private walletDemoAttemptKey(orderId: string, action: WalletDemoAction): string {
    try {
      const stored = JSON.parse(localStorage.getItem(WALLET_DEMO_ATTEMPT_KEY) ?? 'null') as {
        orderId?: string;
        action?: WalletDemoAction;
        idempotencyKey?: string;
      } | null;
      if (stored?.orderId === orderId && stored.action === action && typeof stored.idempotencyKey === 'string') {
        return stored.idempotencyKey;
      }
    } catch {
      /* A new non-sensitive retry key is safe when storage is malformed. */
    }
    const idempotencyKey = crypto.randomUUID();
    try {
      localStorage.setItem(WALLET_DEMO_ATTEMPT_KEY, JSON.stringify({ orderId, action, idempotencyKey }));
    } catch {
      /* The backend order lock and uniqueness constraints remain authoritative. */
    }
    return idempotencyKey;
  }

  private cancellationAttemptKey(orderId: string, rotate = false): string {
    try {
      const stored = JSON.parse(localStorage.getItem(CANCELLATION_ATTEMPT_KEY) ?? 'null') as {
        orderId?: string;
        idempotencyKey?: string;
      } | null;
      if (!rotate && stored?.orderId === orderId && typeof stored.idempotencyKey === 'string') return stored.idempotencyKey;
    } catch {
      /* The server remains authoritative when local storage is unavailable or malformed. */
    }
    const idempotencyKey = crypto.randomUUID();
    try {
      localStorage.setItem(CANCELLATION_ATTEMPT_KEY, JSON.stringify({ orderId, idempotencyKey }));
    } catch {
      /* The in-flight request still carries one idempotency key. */
    }
    return idempotencyKey;
  }

  private reorderAttemptKey(orderId: string): string {
    try {
      const stored = JSON.parse(localStorage.getItem(REORDER_ATTEMPT_KEY) ?? '{}') as Record<string, unknown>;
      if (typeof stored?.[orderId] === 'string') return stored[orderId];
    } catch {
      /* Malformed storage cannot be trusted for request replay. */
    }
    const idempotencyKey = crypto.randomUUID();
    try {
      const stored = JSON.parse(localStorage.getItem(REORDER_ATTEMPT_KEY) ?? '{}') as Record<string, unknown>;
      localStorage.setItem(REORDER_ATTEMPT_KEY, JSON.stringify({ ...stored, [orderId]: idempotencyKey }));
    } catch {
      /* The server still protects the in-flight request with its idempotency key. */
    }
    return idempotencyKey;
  }

  private clearReorderAttemptKey(orderId: string, idempotencyKey: string): void {
    try {
      const stored = JSON.parse(localStorage.getItem(REORDER_ATTEMPT_KEY) ?? '{}') as Record<string, unknown>;
      if (stored?.[orderId] !== idempotencyKey) return;
      delete stored[orderId];
      if (Object.keys(stored).length) localStorage.setItem(REORDER_ATTEMPT_KEY, JSON.stringify(stored));
      else localStorage.removeItem(REORDER_ATTEMPT_KEY);
    } catch {
      /* Do not erase another order's unresolved retry key when storage is malformed. */
    }
  }
}

export function trustedCheckoutUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'checkout.paymongo.com';
  } catch {
    return false;
  }
}

export function trustedAuthorizationUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password;
  } catch {
    return false;
  }
}

export function isAmbiguousOrderError(error: unknown): boolean {
  if (!(error instanceof HttpErrorResponse)) return false;
  if (error.status === 0 || error.status >= 500) return true;
  return error.status === 409 && typeof error.error?.message === 'string' && /checkout key/i.test(error.error.message);
}

export async function fingerprintOrderDetails(details: OrderDetails): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalOrderDetails(details));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
