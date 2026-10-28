/**
 * @file order-confirmation.page.ts
 * @description Refresh-safe order confirmation loaded from the authenticated order API.
 */
import { DatePipe, DecimalPipe } from '@angular/common';
import { Component, OnDestroy, ViewChild, effect, inject, signal, untracked } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import {
  IonButton,
  IonBackButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonIcon,
  IonSpinner,
  IonTitle,
  IonToolbar,
  AlertController,
  ModalController,
} from '@ionic/angular';
import { AuthService } from '../../core/auth.service';
import { apiErrorMessage } from '../../core/api-error';
import { CartService } from '../../core/cart.service';
import { DemoCardFormComponent } from '../../components/demo-card-form.component';
import { presentSimulatedCardVerification } from '../../components/simulated-card-verification.modal';
import { presentSimulatedWalletConfirmation } from '../../components/simulated-wallet-confirmation.modal';
import { DemoCardFlow, DemoCardScenario, demoScenarioForFlow } from '../../core/demo-card';
import { Order, RefundStatus, ReorderResult } from '../../core/models';
import { OrderService } from '../../core/order.service';
import { LiveService } from '../../core/live.service';
import { ProductService } from '../../core/product.service';
import { isOnlinePayment, paymentLabel } from '../../core/checkout-rules';
import { OrderTracking, ReviewService } from '../../core/review.service';
import { OrderTrackerMapComponent } from '../../components/order-tracker-map.component';
import { OrderReviewComponent } from '../../components/order-review.component';
import { PhotoPipe } from '../../core/photo.pipe';
import { AsyncPipe } from '@angular/common';

const PROVIDER_PAYMENT_ERRORS = new Set([
  'Secure payment is not configured.',
  'That payment method is unavailable.',
  'Your wallet could not be prepared. Try again.',
  'Wallet authorization could not be started. Try again.',
  'Wallet authorization was not completed. Try again.',
]);

export function paymentRecoveryErrorMessage(error: unknown): string {
  if (error instanceof HttpErrorResponse) {
    if (error.status === 0 || error.status === 504) {
      return 'We could not reach Cookie Fluffs. Check your connection and try again.';
    }
    if (error.status === 401) return 'Your session ended. Log in again before continuing payment.';
    if (error.status === 409 && typeof error.error?.message === 'string' && /already paid/i.test(error.error.message)) {
      return 'This order may already be paid. Refresh payment status before trying again.';
    }
    if ([409, 410, 503].includes(error.status)) {
      return 'Secure payment is unavailable for this order. Refresh payment status, then try again.';
    }
  }
  if (error instanceof TypeError) {
    return 'We could not reach the payment provider. Check your connection and try again.';
  }
  if (error instanceof Error && error.message === 'The wallet authorization link is invalid.') {
    return 'The secure payment link is missing or invalid. Refresh payment status before trying again.';
  }
  if (error instanceof Error && PROVIDER_PAYMENT_ERRORS.has(error.message)) return error.message;
  return 'Secure payment is unavailable right now. Refresh payment status, then try again.';
}

export function paymentStatusMessage(paymentStatus: Order['paymentStatus'], returned: string | null): string {
  if (paymentStatus === 'failed') {
    return 'Secure payment failed. Your order was not charged. You can safely try payment again.';
  }
  if (returned === 'cancel' && paymentStatus !== 'paid') {
    return 'Secure payment was not confirmed. You can continue the same payment without creating another order.';
  }
  if ((returned === 'return' || returned === 'retry') && paymentStatus !== 'paid') {
    return 'Payment is not confirmed yet. Refresh the status or continue secure payment for this order.';
  }
  return '';
}

export function shouldRefreshPaymentOnReturn(order: Order | null, loggedIn: boolean): boolean {
  return loggedIn
    && !!order
    && !order.paymentIsDemo
    && isOnlinePayment(order.paymentMethod)
    && !['paid', 'failed', 'expired', 'cancelled', 'refunded'].includes(order.paymentStatus);
}

export function shouldPollOrderLifecycle(order: Order | null, isOrderDetail: boolean): boolean {
  return !!order && isOrderDetail && !['completed', 'cancelled'].includes(order.orderStatus);
}

export function cancellationConfirmation(order: Order): {
  header: string;
  message: string;
  confirmText: string;
} {
  const reference = order.id.split('-')[0].toUpperCase();
  const requestsReview = order.cancellationAction === 'request';
  return {
    header: requestsReview
      ? `Request cancellation for #${reference}?`
      : `Cancel order #${reference}?`,
    message: `${requestsReview
      ? 'Cookie Fluffs will review your request. Your order is not cancelled unless the request is approved.'
      : 'Confirming will stop fulfillment for this order.'}${order.paymentStatus === 'paid'
      ? ' Your payment will remain Paid. Cancellation does not automatically issue a refund.'
      : ''}`,
    confirmText: requestsReview ? 'Submit request' : 'Confirm cancellation',
  };
}

export class PaymentReturnRefreshGate {
  private pending: Promise<void> | null = null;

  run(task: () => Promise<void>): Promise<void> {
    if (this.pending) return this.pending;
    const pending = Promise.resolve().then(task).finally(() => {
      if (this.pending === pending) this.pending = null;
    });
    this.pending = pending;
    return pending;
  }
}

export function orderDocumentTitle(order: Order): string {
  if (order.refund?.status === 'refunded') return 'Refund Confirmation';
  if (order.refund?.status === 'review_required') return 'Cancelled Order — Refund Review';
  if (order.refund?.status === 'approved') return 'Cancelled Order — Refund Approved for Processing';
  if (order.refund?.status === 'processing') return 'Cancelled Order — Refund Processing';
  if (order.refund?.status === 'rejected') return 'Cancelled Order — Refund Not Approved';
  if (order.refund?.status === 'failed') return 'Cancelled Order — Refund Needs Help';
  const demoStatus = order.walletDemoPayment?.status ?? order.demoPayment?.status;
  if (order.paymentIsDemo && demoStatus === 'demo_approved') return 'Demo Receipt — No Real Payment Processed';
  if (order.paymentIsDemo) return 'Unpaid Order Summary';
  if (order.paymentStatus === 'paid') return 'Payment Receipt';
  if (order.paymentMethod === 'cash_on_delivery' || order.paymentMethod === 'cash_on_pickup') {
    return 'Order Confirmation — Payment Due';
  }
  return 'Order Summary — Payment Pending';
}

@Component({
  selector: 'app-order-confirmation',
  templateUrl: 'order-confirmation.page.html',
  styleUrls: ['order-confirmation.page.scss'],
  imports: [PhotoPipe, AsyncPipe, 
    DatePipe,
    DecimalPipe,
    RouterLink,
    IonHeader,
    IonToolbar,
    IonButtons,
    IonButton,
    IonBackButton,
    IonIcon,
    IonContent,
    IonTitle,
    IonSpinner,
    DemoCardFormComponent,
    OrderTrackerMapComponent,
    OrderReviewComponent,
  ],
})
export class OrderConfirmationPage implements OnDestroy {
  @ViewChild(DemoCardFormComponent) private demoCardForm?: DemoCardFormComponent;

  readonly auth = inject(AuthService);
  private orders = inject(OrderService);
  private cart = inject(CartService);
  readonly products = inject(ProductService);
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private modals = inject(ModalController);
  private alerts = inject(AlertController);

  readonly order = signal<Order | null>(null);
  readonly loading = signal(true);
  readonly error = signal('');
  readonly needsLogin = signal(false);
  readonly paymentAction = signal(false);
  readonly paymentPolling = signal(false);
  readonly popupBlocked = signal(false);
  readonly paymentMessage = signal('');
  readonly demoFlow = signal<DemoCardFlow | null>(null);
  readonly cancellationAction = signal(false);
  readonly cancellationError = signal('');
  readonly reordering = signal(false);
  readonly reorderResult = signal<ReorderResult | null>(null);
  readonly reorderError = signal('');
  private stopPaymentPolling?: () => void;
  private stopLifecyclePolling?: () => void;
  private readonly returnRefresh = new PaymentReturnRefreshGate();
  private returnListenersActive = false;
  private readonly onWindowFocus = () => this.refreshOrderOnReturn();
  private readonly onVisibilityChange = () => {
    if (document.visibilityState === 'visible') this.refreshOrderOnReturn();
  };

  private live = inject(LiveService);
  private reviews = inject(ReviewService);
  /** Map points for the tracker (kitchen and the geocoded delivery address). */
  readonly tracking = signal<OrderTracking | null>(null);

  /** Live updates: when the admin (or payment) changes this order, refresh it in place. */
  private readonly liveRefresh = effect(() => {
    const change = this.live.orderChange();
    const current = untracked(() => this.order());
    if (!change || !current || change.orderId !== current.id) return;
    if (!untracked(() => this.tracking())) void this.loadTracking(current.id);
    void this.orders
      .get(current.id)
      .then((fresh) => this.order.set(fresh))
      .catch(() => undefined);
  });

  async ionViewWillEnter(): Promise<void> {
    this.startReturnRefreshListeners();
    if (!this.auth.isLoggedIn()) {
      await this.login();
      return;
    }
    await this.load();
  }

  async load(): Promise<void> {
    const id = this.route.snapshot.paramMap.get('id') ?? '';
    this.stopPolling();
    this.stopLifecycleRefresh();
    this.loading.set(true);
    this.error.set('');
    this.needsLogin.set(false);
    try {
      const order = await this.orders.get(id);
      this.order.set(order);
      void this.loadTracking(order.id);
      const returned = this.route.snapshot.queryParamMap.get('payment');
      this.popupBlocked.set(returned === 'popup-blocked');
      if (returned === 'popup-open' && order.paymentStatus !== 'paid') {
        this.paymentMessage.set('PayMongo Test Mode opened in a separate window. Keep this page open while we verify payment.');
        this.startPaymentPolling(order, this.orders.activePaymentPopup(order.id));
      } else if (returned === 'popup-blocked' && order.paymentStatus !== 'paid') {
        this.paymentMessage.set('Your browser blocked the payment window. Continue in this tab or allow popups and try again.');
      } else {
        this.paymentMessage.set(paymentStatusMessage(order.paymentStatus, returned));
      }
      this.startLifecyclePolling(order);
    } catch (error) {
      this.order.set(null);
      if (error instanceof HttpErrorResponse && error.status === 401) {
        this.needsLogin.set(true);
        this.error.set('Your session ended. Log in again to view this order.');
      } else if (error instanceof HttpErrorResponse && error.status === 404) {
        this.error.set('We couldn’t find this order for your account. Check the link or return to shopping.');
      } else {
        this.error.set(apiErrorMessage(error));
      }
    } finally {
      this.loading.set(false);
    }
  }

  private async loadTracking(id: string): Promise<void> {
    try {
      this.tracking.set(await this.reviews.tracking(id));
    } catch {
      this.tracking.set(null); // the map is a bonus; the timeline below still shows progress
    }
  }

  /** When the order left the kitchen, so the rider starts moving from that moment. */
  outForDeliveryAt(order: Order): string | null {
    return order.events.find((e) => e.toStatus === 'out_for_delivery')?.createdAt ?? null;
  }

  ionViewDidLeave(): void {
    this.stopReturnRefreshListeners();
    this.stopPolling();
    this.stopLifecycleRefresh();
  }

  ngOnDestroy(): void {
    this.stopReturnRefreshListeners();
    this.stopPolling();
    this.stopLifecycleRefresh();
  }

  login(): Promise<boolean> {
    return this.router.navigate(['/login'], {
      queryParams: { returnUrl: this.router.url },
      replaceUrl: this.needsLogin(),
    });
  }

  shortReference(id: string): string {
    return id.split('-')[0].toUpperCase();
  }

  isOrderDetail(): boolean {
    return this.route.snapshot.routeConfig?.path === 'orders/:id';
  }

  documentTitle(order: Order): string {
    return orderDocumentTitle(order);
  }

  /** Opens the printable receipt page; its back arrow returns here (same scroll position). */
  printReceipt(): void {
    const order = this.order();
    if (order) void this.router.navigate(['/orders', order.id, 'receipt']);
  }

  async reorder(): Promise<void> {
    const order = this.order();
    if (!order || !this.isOrderDetail() || this.reordering()) return;
    this.reorderResult.set(null);
    this.reorderError.set('');
    if (!this.products.online()) {
      this.reorderError.set('Reconnect to Cookie Fluffs before adding this order to your cart.');
      return;
    }
    this.reordering.set(true);
    try {
      const result = await this.orders.reorder(order.id);
      this.cart.replaceFromServer(result.cart);
      this.reorderResult.set(result);
    } catch (error) {
      this.reorderError.set(apiErrorMessage(error));
    } finally {
      this.reordering.set(false);
    }
  }

  paymentLabel(order: Order): string {
    return paymentLabel(order.paymentMethod);
  }

  isOnline(order: Order): boolean {
    return isOnlinePayment(order.paymentMethod);
  }

  isWalletDemo(order: Order): boolean {
    return !!order.paymentIsDemo && ['gcash', 'maya'].includes(order.paymentMethod);
  }

  paymentStatusLabel(order: Order): string {
    if (order.paymentIsDemo) {
      if (this.isWalletDemo(order)) {
        if (order.walletDemoPayment?.status === 'demo_approved') return 'Test approved';
        if (order.walletDemoPayment?.status === 'demo_cancelled') return 'Test cancelled';
        return 'Test awaiting confirmation';
      }
      if (order.demoPayment?.status === 'demo_approved') return 'Demo approved';
      if (order.demoPayment?.status === 'demo_declined') return 'Demo declined';
      return 'Demo awaiting result';
    }
    if (order.orderStatus === 'cancelled' && ['pending', 'pending_cash', 'awaiting_payment'].includes(order.paymentStatus)) return 'No payment due';
    return {
      paid: 'Paid',
      processing: 'Processing',
      failed: 'Failed',
      expired: 'Expired',
      cancelled: 'Cancelled',
      refunded: 'Refunded',
      pending: 'Pending',
      pending_cash: 'Pending cash payment',
      awaiting_payment: 'Awaiting payment',
    }[order.paymentStatus];
  }

  orderStatusLabel(status: string, fulfillmentMethod: Order['fulfillmentMethod'] = 'delivery'): string {
    return {
      placed: 'Placed',
      confirmed: 'Confirmed',
      preparing: 'Preparing',
      ready: fulfillmentMethod === 'pickup' ? 'Ready for pickup' : 'Ready for delivery',
      out_for_delivery: 'Out for delivery',
      completed: 'Completed',
      cancelled: 'Cancelled',
    }[status] ?? 'Order received';
  }

  eventSource(event: Order['events'][number]): string {
    return event.actorType === 'customer' ? 'Updated by you' : event.actorType === 'operator' ? 'Updated by Cookie Fluffs' : 'Order update';
  }

  cancellationActionLabel(order: Order): string {
    return order.cancellationAction === 'request' ? 'Request cancellation' : 'Cancel order';
  }

  refundStatusLabel(status: RefundStatus): string {
    return {
      review_required: 'Review required',
      approved: 'Approved for processing',
      processing: 'Processing',
      refunded: 'Refunded',
      rejected: 'Not approved',
      failed: 'Needs help',
    }[status];
  }

  refundStatusMessage(status: RefundStatus): string {
    return {
      review_required: 'Cookie Fluffs is reviewing this refund. Your payment remains Paid during review.',
      approved: 'The full refund is approved for processing. No provider refund has been confirmed yet.',
      processing: 'The refund is being processed. It is not complete until the payment provider confirms it.',
      refunded: 'The refund was confirmed by a trusted financial source.',
      rejected: 'The refund review was not approved. Contact Cookie Fluffs if you need help.',
      failed: 'The refund could not be completed. Contact Cookie Fluffs for the next step.',
    }[status];
  }

  async confirmCancellation(): Promise<void> {
    const order = this.order();
    if (!order?.cancellationAction || this.cancellationAction()) return;
    const confirmation = cancellationConfirmation(order);
    const alert = await this.alerts.create({
      header: confirmation.header,
      message: confirmation.message,
      cssClass: 'cf-alert-confirm',
      buttons: [
        { text: 'Keep order', role: 'cancel' },
        { text: confirmation.confirmText, role: 'destructive', handler: () => void this.submitCancellation() },
      ],
    });
    await alert.present();
  }

  async submitCancellation(): Promise<void> {
    const order = this.order();
    if (!order?.cancellationAction || this.cancellationAction()) return;
    this.cancellationAction.set(true);
    this.cancellationError.set('');
    try {
      const updated = await this.orders.requestCancellation(order.id, order.cancellation?.status === 'declined');
      this.order.set(updated);
      this.startLifecyclePolling(updated);
    } catch (error) {
      this.cancellationError.set(error instanceof HttpErrorResponse && error.status === 409
        ? 'This order changed before cancellation could be completed. Refresh the order and check its current status.'
        : apiErrorMessage(error));
    } finally {
      this.cancellationAction.set(false);
    }
  }

  itemImage(orderItem: Order['items'][number]): string | null {
    return orderItem.imageUrl ?? orderItem.boxItems.find((item) => item.imageUrl)?.imageUrl ?? null;
  }

  hideBrokenImage(event: Event): void {
    (event.currentTarget as HTMLImageElement).hidden = true;
  }

  async continuePayment(): Promise<void> {
    const order = this.order();
    if (!order || !this.isOnline(order) || order.paymentStatus === 'paid' || this.paymentAction() || this.paymentPolling()) return;
    if (order.paymentIsDemo) {
      if (this.isWalletDemo(order)) {
        const action = await presentSimulatedWalletConfirmation(this.modals, {
          walletLabel: paymentLabel(order.paymentMethod),
          orderReference: this.shortReference(order.id),
          amount: order.total,
        });
        if (!action) {
          this.paymentMessage.set('Test wallet confirmation was closed. Your order is unchanged.');
          return;
        }
        this.paymentAction.set(true);
        this.paymentMessage.set('');
        try {
          await this.orders.submitDemoWallet(order.id, action);
          await this.load();
        } catch {
          this.paymentMessage.set('The test wallet payment could not be completed. Try again.');
        } finally {
          this.paymentAction.set(false);
        }
        return;
      }
      const flow = this.demoCardForm?.validate() ?? this.demoFlow();
      if (!flow) return;
      const scenario = await this.resolveDemoScenario(flow);
      if (!scenario) {
        this.paymentMessage.set('Test verification was closed. Your order is unchanged, and you can continue when ready.');
        return;
      }
      this.paymentAction.set(true);
      this.paymentMessage.set('');
      try {
        await this.orders.submitDemoCard(order.id, scenario);
        this.demoCardForm?.clear();
        await this.load();
      } catch {
        this.paymentMessage.set('The card demo could not be completed. Check the supplied demo values and try again.');
      } finally {
        this.paymentAction.set(false);
      }
      return;
    }
    if (['gcash', 'maya'].includes(order.paymentMethod) && this.orders.supportsDesktopPaymentPopup()) {
      const popup = this.orders.openPaymentPopup(order.id);
      if (!popup) {
        this.popupBlocked.set(true);
        this.paymentMessage.set('Your browser blocked the payment window. Continue in this tab or allow popups and try again.');
        return;
      }
      this.popupBlocked.set(false);
      this.paymentMessage.set('PayMongo Test Mode opened in a separate window. Keep this page open while we verify payment.');
      this.startPaymentPolling(order, popup);
      return;
    }
    await this.continuePaymentInTab();
  }

  async continuePaymentInTab(): Promise<void> {
    const order = this.order();
    if (!order || order.paymentIsDemo || !this.isOnline(order) || order.paymentStatus === 'paid' || this.paymentAction()) return;
    this.paymentAction.set(true);
    this.popupBlocked.set(false);
    this.paymentMessage.set('');
    try {
      const config = await this.orders.paymentConfig();
      await this.orders.startIntegratedPayment(order, config);
    } catch (error) {
      this.paymentMessage.set(paymentRecoveryErrorMessage(error));
    } finally {
      this.paymentAction.set(false);
    }
  }

  private startPaymentPolling(order: Order, popup: Window | null): void {
    this.stopPolling();
    this.stopLifecycleRefresh();
    this.paymentPolling.set(true);
    let closureReported = false;
    this.stopPaymentPolling = this.orders.pollPaymentStatus(order.id, {
      onOrder: (updated) => {
        if (this.order()?.id !== updated.id) return;
        this.order.set(updated);
        if (updated.paymentStatus === 'paid') {
          this.paymentMessage.set('Payment confirmed by the provider.');
          this.paymentPolling.set(false);
          this.startLifecyclePolling(updated);
        } else if (['failed', 'expired', 'cancelled'].includes(updated.paymentStatus)) {
          this.paymentMessage.set('Secure payment was not completed. Your order remains unpaid, and you can safely try again.');
          this.paymentPolling.set(false);
        } else if (popup?.closed && !closureReported) {
          closureReported = true;
          this.paymentMessage.set('The payment window was closed. We will keep checking briefly, but closure does not confirm payment.');
        }
      },
      onTimeout: () => {
        this.paymentPolling.set(false);
        this.paymentMessage.set('Payment is not confirmed yet. Refresh the status before trying another payment.');
      },
      onError: (error) => {
        if (error instanceof HttpErrorResponse && error.status === 401) {
          this.paymentPolling.set(false);
          this.paymentMessage.set('Your session ended. Log in again to check payment status.');
          return true;
        }
        return false;
      },
      shouldContinue: () => {
        const shouldContinue = this.auth.isLoggedIn()
          && this.order()?.id === order.id
          && !['paid', 'failed', 'expired', 'cancelled'].includes(this.order()?.paymentStatus ?? '');
        if (!shouldContinue) this.paymentPolling.set(false);
        return shouldContinue;
      },
    });
  }

  private refreshOrderOnReturn(): void {
    if (!this.auth.isLoggedIn() || !this.order()) return;
    void this.returnRefresh.run(async () => {
      const current = this.order();
      if (!current || !this.auth.isLoggedIn()) return;
      this.stopPolling();
      this.stopLifecycleRefresh();
      try {
        const updated = await this.orders.get(current.id);
        if (this.order()?.id !== updated.id) return;
        this.order.set(updated);
        if (shouldRefreshPaymentOnReturn(current, true) && updated.paymentStatus === 'paid') {
          this.paymentMessage.set('Payment confirmed by the provider.');
        } else if (shouldRefreshPaymentOnReturn(current, true) && ['failed', 'expired', 'cancelled'].includes(updated.paymentStatus)) {
          this.paymentMessage.set('Secure payment was not completed. Your order remains unpaid, and you can safely try again.');
        } else if (shouldRefreshPaymentOnReturn(updated, true)) {
          this.paymentMessage.set('Payment is not confirmed yet. We will keep checking for verified confirmation.');
          this.startPaymentPolling(updated, this.orders.activePaymentPopup(updated.id));
        }
        if (!this.paymentPolling()) this.startLifecyclePolling(updated);
      } catch (error) {
        this.paymentMessage.set(error instanceof HttpErrorResponse && error.status === 401
          ? 'Your session ended. Log in again to check payment status.'
          : 'Payment status could not be refreshed. Use Refresh payment status to try again.');
      }
    });
  }

  private startReturnRefreshListeners(): void {
    if (this.returnListenersActive) return;
    window.addEventListener('focus', this.onWindowFocus);
    document.addEventListener('visibilitychange', this.onVisibilityChange);
    this.returnListenersActive = true;
  }

  private stopReturnRefreshListeners(): void {
    if (!this.returnListenersActive) return;
    window.removeEventListener('focus', this.onWindowFocus);
    document.removeEventListener('visibilitychange', this.onVisibilityChange);
    this.returnListenersActive = false;
  }

  private stopPolling(): void {
    this.stopPaymentPolling?.();
    this.stopPaymentPolling = undefined;
    this.paymentPolling.set(false);
  }

  private startLifecyclePolling(order: Order): void {
    this.stopLifecycleRefresh();
    if (!shouldPollOrderLifecycle(order, this.isOrderDetail()) || this.paymentPolling()) return;
    this.stopLifecyclePolling = this.orders.pollOrderLifecycle(order.id, {
      onOrder: (updated) => {
        if (this.order()?.id !== updated.id) return;
        this.order.set(updated);
      },
      onTimeout: () => undefined,
      onError: (error) => error instanceof HttpErrorResponse && error.status === 401,
      shouldContinue: () => this.auth.isLoggedIn()
        && !this.paymentPolling()
        && this.order()?.id === order.id
        && shouldPollOrderLifecycle(this.order(), this.isOrderDetail()),
    });
  }

  private stopLifecycleRefresh(): void {
    this.stopLifecyclePolling?.();
    this.stopLifecyclePolling = undefined;
  }

  private async resolveDemoScenario(flow: DemoCardFlow): Promise<DemoCardScenario | null> {
    if (flow !== 'three_ds') return demoScenarioForFlow(flow);
    const approved = await presentSimulatedCardVerification(this.modals);
    return approved === null ? null : demoScenarioForFlow(flow, approved);
  }

  boxItemsSummary(order: Order['items'][number]): string {
    return order.boxItems.map((item) => item.productName).join(', ');
  }
}
