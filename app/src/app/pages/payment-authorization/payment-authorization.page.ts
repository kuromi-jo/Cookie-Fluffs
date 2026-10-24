/**
 * @file payment-authorization.page.ts
 * @description Same-origin handoff page for genuine PayMongo wallet authorization in a top-level window.
 */
import { Component, OnDestroy, inject, signal } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import {
  IonButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonIcon,
  IonSpinner,
  IonTitle,
  IonToolbar,
} from '@ionic/angular';
import { AuthService } from '../../core/auth.service';
import { Order, PaymentConfig } from '../../core/models';
import { OrderService } from '../../core/order.service';

export function canAuthorizeRealWallet(order: Order, config: PaymentConfig): boolean {
  if (order.paymentIsDemo || order.paymentStatus === 'paid' || !['gcash', 'maya'].includes(order.paymentMethod)) {
    return false;
  }
  return config.methods.some((method) => method.id === order.paymentMethod && method.available && !method.demo);
}

export function popupReturnUrl(origin: string, orderId: string): string {
  return `${origin}/payment-authorization/${encodeURIComponent(orderId)}?payment=return`;
}

export function checkoutPopupFailureMessage(reason: string | null): string | null {
  if (reason === 'cart-unavailable') return 'Your selected cart items changed before the order was placed.';
  if (reason === 'cart-changed') return 'Your cart changed before the order was placed. Review the updated checkout before trying again.';
  if (reason === 'order-failed') return 'The order could not be placed. Return to checkout to review the error and try again.';
  return null;
}

@Component({
  selector: 'app-payment-authorization',
  templateUrl: 'payment-authorization.page.html',
  styleUrls: ['payment-authorization.page.scss'],
  imports: [IonHeader, IonToolbar, IonTitle, IonButtons, IonButton, IonIcon, IonContent, IonSpinner],
})
export class PaymentAuthorizationPage implements OnDestroy {
  private readonly auth = inject(AuthService);
  private readonly orders = inject(OrderService);
  private readonly route = inject(ActivatedRoute);
  private stopPolling?: () => void;

  readonly phase = signal<'waiting' | 'opening' | 'checking' | 'paid' | 'error'>('waiting');
  readonly message = signal('Keep this window open while Cookie Fluffs prepares your order.');
  readonly orderReference = signal('');

  async ionViewWillEnter(): Promise<void> {
    const orderId = this.route.snapshot.paramMap.get('id') ?? '';
    if (!orderId) {
      const failure = checkoutPopupFailureMessage(this.route.snapshot.queryParamMap.get('checkoutFailure'));
      if (failure) this.fail(failure);
      return;
    }
    this.orderReference.set(orderId.split('-')[0].toUpperCase());
    if (!this.auth.isLoggedIn()) {
      this.fail('Your session ended. Return to Cookie Fluffs and log in again.');
      return;
    }
    window.opener = null;
    if (this.route.snapshot.queryParamMap.get('payment') === 'return') {
      await this.checkReturnedPayment(orderId);
      return;
    }
    await this.beginAuthorization(orderId);
  }

  ngOnDestroy(): void {
    this.stopPolling?.();
  }

  close(): void {
    window.close();
  }

  returnToCheckout(): void {
    window.location.assign('/checkout');
  }

  private async beginAuthorization(orderId: string): Promise<void> {
    this.phase.set('opening');
    this.message.set('Opening PayMongo Test Mode authorization…');
    try {
      const [order, config] = await Promise.all([this.orders.get(orderId), this.orders.paymentConfig()]);
      if (!canAuthorizeRealWallet(order, config)) {
        this.fail(order.paymentStatus === 'paid'
          ? 'This order is already paid. You can close this window.'
          : 'Secure wallet authorization is unavailable for this order.');
        return;
      }
      await this.orders.startIntegratedPayment(order, config, {
        returnUrl: popupReturnUrl(window.location.origin, order.id),
      });
    } catch {
      this.fail('PayMongo authorization could not be opened. Return to your order and try again.');
    }
  }

  private async checkReturnedPayment(orderId: string): Promise<void> {
    this.phase.set('checking');
    this.message.set('Authorization returned. Waiting for verified payment confirmation…');
    try {
      const order = await this.orders.get(orderId);
      if (order.paymentStatus === 'paid') {
        this.confirmPaid();
        return;
      }
      if (['failed', 'expired', 'cancelled'].includes(order.paymentStatus)) {
        this.fail('Secure payment was not completed. Return to your order to try again safely.');
        return;
      }
    } catch {
      this.fail('Payment status could not be checked. Return to your order and refresh its status.');
      return;
    }
    this.stopPolling = this.orders.pollPaymentStatus(orderId, {
      onOrder: (order) => {
        if (order.paymentStatus === 'paid') this.confirmPaid();
        else if (['failed', 'expired', 'cancelled'].includes(order.paymentStatus)) {
          this.fail('Secure payment was not completed. Return to your order to try again safely.');
        }
      },
      onTimeout: () => this.message.set('Payment is not confirmed yet. Return to your order and refresh its status.'),
      onError: () => false,
      shouldContinue: () => this.phase() === 'checking',
    }, 2_000, 15);
  }

  private confirmPaid(): void {
    this.phase.set('paid');
    this.message.set('Payment confirmed. Return to Cookie Fluffs to view your order.');
  }

  private fail(message: string): void {
    this.phase.set('error');
    this.message.set(message);
  }
}
