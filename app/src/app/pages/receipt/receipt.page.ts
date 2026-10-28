/**
 * @file receipt.page.ts
 * @description Printable order receipt (/orders/:id/receipt). Reads like a paper receipt on the phone,
 * prints cleanly, and "Print or save as PDF" opens the system print screen (Android print dialog on
 * the APK). The back arrow returns to the exact page the receipt was opened from.
 */
import { Component, inject, input, signal } from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';
import { HttpErrorResponse } from '@angular/common/http';
import { Router } from '@angular/router';
import {
  IonButton, IonButtons, IonContent, IonFooter, IonHeader, IonIcon, IonSpinner, IonTitle, IonToolbar, NavController,
} from '@ionic/angular';
import { Order } from '../../core/models';
import { OrderService } from '../../core/order.service';
import { AuthService } from '../../core/auth.service';
import { UiService } from '../../core/ui.service';
import { BackNavService } from '../../core/back-nav.service';
import { apiErrorMessage } from '../../core/api-error';
import { paymentLabel } from '../../core/checkout-rules';
import { printReceipt } from '../../core/receipt-print';
import { orderDocumentTitle } from '../order-confirmation/order-confirmation.page';

const PAYMENT_STATUS: Record<string, string> = {
  paid: 'Paid',
  processing: 'Processing',
  failed: 'Failed',
  expired: 'Expired',
  cancelled: 'Cancelled',
  refunded: 'Refunded',
  pending: 'Pending',
  pending_cash: 'Pay on handover',
  awaiting_payment: 'Awaiting payment',
};

@Component({
  selector: 'app-receipt',
  templateUrl: 'receipt.page.html',
  styleUrls: ['receipt.page.scss'],
  imports: [DatePipe, DecimalPipe, IonHeader, IonToolbar, IonButtons, IonButton, IonIcon, IonTitle, IonContent, IonFooter, IonSpinner],
})
export class ReceiptPage {
  /** Route parameter :id (bound by withComponentInputBinding). */
  readonly id = input.required<string>();

  private orders = inject(OrderService);
  private auth = inject(AuthService);
  private router = inject(Router);
  private nav = inject(NavController);
  private ui = inject(UiService);
  /** Captured while this page is being created, so it is the page the receipt was opened from. */
  private readonly backHref = inject(BackNavService).backHref('', '');

  readonly order = signal<Order | null>(null);
  readonly loading = signal(true);
  readonly error = signal('');
  readonly printing = signal(false);

  async ionViewWillEnter(): Promise<void> {
    if (!this.auth.isLoggedIn()) {
      await this.router.navigate(['/login'], { queryParams: { returnUrl: this.router.url }, replaceUrl: true });
      return;
    }
    if (this.order()?.id === this.id()) return;
    await this.load();
  }

  async load(): Promise<void> {
    this.loading.set(true);
    this.error.set('');
    try {
      this.order.set(await this.orders.get(this.id()));
    } catch (err) {
      this.error.set(err instanceof HttpErrorResponse && err.status === 404
        ? 'We couldn’t find this order for your account.'
        : apiErrorMessage(err));
    } finally {
      this.loading.set(false);
    }
  }

  back(): void {
    void this.nav.navigateBack(this.backHref || `/orders/${this.id()}`);
  }

  async print(): Promise<void> {
    const order = this.order();
    if (!order || this.printing()) return;
    this.printing.set(true);
    try {
      await printReceipt(`Cookie Fluffs receipt #${this.reference(order)}`);
    } catch {
      await this.ui.toast('Printing isn’t available on this device. You can take a screenshot of this receipt instead.', { error: true });
    } finally {
      this.printing.set(false);
    }
  }

  reference(order: Order): string {
    return order.id.split('-')[0].toUpperCase();
  }

  title(order: Order): string {
    return orderDocumentTitle(order);
  }

  payment(order: Order): string {
    return paymentLabel(order.paymentMethod);
  }

  paymentStatus(order: Order): string {
    if (order.orderStatus === 'cancelled' && ['pending', 'pending_cash', 'awaiting_payment'].includes(order.paymentStatus)) return 'No payment due';
    return PAYMENT_STATUS[order.paymentStatus] ?? 'Pending';
  }

  boxContents(item: Order['items'][number]): string {
    return item.boxItems.map((b) => b.productName).join(', ');
  }
}
