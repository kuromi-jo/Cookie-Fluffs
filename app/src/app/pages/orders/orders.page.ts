/**
 * @file orders.page.ts
 * @description Authenticated, cursor-paginated order history for the current customer.
 */
import { DatePipe, DecimalPipe } from '@angular/common';
import { Component, effect, inject, signal, untracked } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import {
  IonButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonIcon,
  IonMenuButton,
  IonSpinner,
  IonTitle,
  IonToolbar,
} from '@ionic/angular';
import { apiErrorMessage } from '../../core/api-error';
import { AuthService } from '../../core/auth.service';
import { CartService } from '../../core/cart.service';
import { OrderSummary, ReorderResult } from '../../core/models';
import { OrderService } from '../../core/order.service';
import { LiveService } from '../../core/live.service';
import { paymentLabel } from '../../core/checkout-rules';
import { ProductService } from '../../core/product.service';
import { PhotoPipe } from '../../core/photo.pipe';
import { AsyncPipe } from '@angular/common';

@Component({
  selector: 'app-orders',
  templateUrl: 'orders.page.html',
  styleUrls: ['orders.page.scss'],
  imports: [PhotoPipe, AsyncPipe, 
    DatePipe,
    DecimalPipe,
    RouterLink,
    IonHeader,
    IonToolbar,
    IonButtons,
    IonMenuButton,
    IonTitle,
    IonContent,
    IonButton,
    IonIcon,
    IonSpinner,
  ],
})
export class OrdersPage {
  private auth = inject(AuthService);
  private ordersApi = inject(OrderService);
  private cart = inject(CartService);
  readonly products = inject(ProductService);
  private router = inject(Router);

  readonly orders = signal<OrderSummary[]>([]);
  readonly nextCursor = signal<string | null>(null);
  readonly loading = signal(true);
  readonly loadingMore = signal(false);
  readonly error = signal('');
  readonly reorderingId = signal('');
  readonly reorderOrderId = signal('');
  readonly reorderResult = signal<ReorderResult | null>(null);
  readonly reorderError = signal('');

  private live = inject(LiveService);

  /** Live updates: when any of my orders changes, refresh the first page quietly (no spinner). */
  private readonly liveRefresh = effect(() => {
    if (!this.live.orderChange() || untracked(() => this.loading() || !this.orders().length)) return;
    void this.ordersApi
      .list()
      .then((page) => {
        this.orders.set(page.orders);
        this.nextCursor.set(page.nextCursor);
      })
      .catch(() => undefined);
  });

  async ionViewWillEnter(): Promise<void> {
    if (!this.auth.isLoggedIn()) {
      await this.router.navigate(['/login'], { queryParams: { returnUrl: '/orders' }, replaceUrl: true });
      return;
    }
    await this.load();
  }

  async load(): Promise<void> {
    this.loading.set(true);
    this.error.set('');
    try {
      const page = await this.ordersApi.list();
      this.orders.set(page.orders);
      this.nextCursor.set(page.nextCursor);
    } catch (error) {
      this.error.set(apiErrorMessage(error));
    } finally {
      this.loading.set(false);
    }
  }

  async loadMore(): Promise<void> {
    const cursor = this.nextCursor();
    if (!cursor || this.loadingMore()) return;
    this.loadingMore.set(true);
    this.error.set('');
    try {
      const page = await this.ordersApi.list(10, cursor);
      this.orders.update((current) => [...current, ...page.orders]);
      this.nextCursor.set(page.nextCursor);
    } catch (error) {
      this.error.set(apiErrorMessage(error));
    } finally {
      this.loadingMore.set(false);
    }
  }

  async reorder(order: OrderSummary): Promise<void> {
    if (this.reorderingId()) return;
    this.reorderOrderId.set(order.id);
    this.reorderResult.set(null);
    this.reorderError.set('');
    if (!this.products.online()) {
      this.reorderError.set('Reconnect to Cookie Fluffs before adding a previous order to your cart.');
      return;
    }
    this.reorderingId.set(order.id);
    try {
      const result = await this.ordersApi.reorder(order.id);
      this.cart.replaceFromServer(result.cart);
      this.reorderResult.set(result);
    } catch (error) {
      this.reorderError.set(apiErrorMessage(error));
    } finally {
      this.reorderingId.set('');
    }
  }

  shortReference(id: string): string {
    return id.split('-')[0].toUpperCase();
  }

  paymentMethodLabel(order: OrderSummary): string {
    return paymentLabel(order.paymentMethod);
  }

  paymentStatusLabel(order: OrderSummary): string {
    if (order.paymentIsDemo) {
      if (order.demoPaymentStatus === 'demo_approved') return 'Test approved';
      if (order.demoPaymentStatus === 'demo_declined') return 'Test declined';
      if (order.demoPaymentStatus === 'demo_cancelled') return 'Test cancelled';
      return 'Test awaiting confirmation';
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
      pending_cash: 'Payment due',
      awaiting_payment: 'Awaiting payment',
    }[order.paymentStatus];
  }

  orderStatusLabel(order: OrderSummary): string {
    return {
      placed: 'Placed',
      confirmed: 'Confirmed',
      preparing: 'Preparing',
      ready: order.fulfillmentMethod === 'pickup' ? 'Ready for pickup' : 'Ready for delivery',
      out_for_delivery: 'Out for delivery',
      completed: 'Completed',
      cancelled: 'Cancelled',
    }[order.orderStatus] ?? 'Order received';
  }

  refundStatusLabel(order: OrderSummary): string {
    const status = order.refundStatus;
    if (!status) return '';
    return {
      review_required: 'Refund review',
      approved: 'Refund approved',
      processing: 'Refund processing',
      refunded: 'Refunded',
      rejected: 'Refund not approved',
      failed: 'Refund needs help',
    }[status];
  }

  itemNames(order: OrderSummary): string {
    const names = order.itemNames.slice(0, 2).join(', ');
    return order.itemNames.length > 2 ? `${names} +${order.itemNames.length - 2} more` : names;
  }

  hideBrokenImage(event: Event): void {
    (event.currentTarget as HTMLImageElement).hidden = true;
  }
}
