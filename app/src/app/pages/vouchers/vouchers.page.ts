/**
 * @file vouchers.page.ts
 * @description The signed-in customer's vouchers, their rules and whether each can still be used.
 */
import { Component, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { Router, RouterLink } from '@angular/router';
import {
  IonBackButton,
  IonButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonIcon,
  IonSkeletonText,
  IonTitle,
  IonToolbar,
} from '@ionic/angular';
import { AuthService } from '../../core/auth.service';
import { VoucherService } from '../../core/voucher.service';
import { UiService } from '../../core/ui.service';
import { apiErrorMessage } from '../../core/api-error';
import { Voucher, VoucherStatus } from '../../core/models';

export const VOUCHER_STATUS_LABELS: Record<VoucherStatus, string> = {
  available: 'Ready to use',
  used: 'Used',
  expired: 'Expired',
  unavailable: 'First order only',
};

@Component({
  selector: 'app-vouchers',
  templateUrl: 'vouchers.page.html',
  styleUrls: ['../catalog.scss', 'vouchers.page.scss'],
  imports: [
    RouterLink,
    DatePipe,
    IonHeader,
    IonToolbar,
    IonButtons,
    IonBackButton,
    IonTitle,
    IonContent,
    IonButton,
    IonIcon,
    IonSkeletonText,
  ],
})
export class VouchersPage {
  private auth = inject(AuthService);
  private api = inject(VoucherService);
  private ui = inject(UiService);
  private router = inject(Router);

  readonly vouchers = signal<Voucher[]>([]);
  readonly loading = signal(true);
  readonly error = signal('');
  readonly statusLabels = VOUCHER_STATUS_LABELS;
  readonly skeletons = [1, 2];

  async ionViewWillEnter(): Promise<void> {
    if (!this.auth.isLoggedIn()) {
      await this.router.navigate(['/login'], { queryParams: { returnUrl: '/profile/vouchers' }, replaceUrl: true });
      return;
    }
    await this.load();
  }

  async load(): Promise<void> {
    this.loading.set(true);
    this.error.set('');
    try {
      this.vouchers.set(await this.api.list());
    } catch (error) {
      this.error.set(apiErrorMessage(error));
    } finally {
      this.loading.set(false);
    }
  }

  /** "₱50 off" or "15% off (up to ₱100)". */
  headline(v: Voucher): string {
    if (v.discountType === 'fixed') return `₱${v.discountValue.toLocaleString('en-PH')} off`;
    return `${v.discountValue}% off${v.maxDiscount ? ` (up to ₱${v.maxDiscount.toLocaleString('en-PH')})` : ''}`;
  }

  rules(v: Voucher): string[] {
    const rules: string[] = [];
    if (v.minSpend > 0) rules.push(`Minimum ₱${v.minSpend.toLocaleString('en-PH')} on cookies`);
    if (v.requiredSeason === 'halloween') rules.push('Order must include a Halloween special');
    if (v.firstOrderOnly) rules.push('First order only');
    rules.push(v.oncePerUser ? 'One use per account' : 'Use on any number of orders');
    return rules;
  }

  async copy(code: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(code);
      void this.ui.toast(`Copied ${code}. Paste it at checkout.`, { icon: 'copy-outline' });
    } catch {
      void this.ui.toast(`Your code is ${code}. Type it at checkout.`, { icon: 'ticket-outline' });
    }
  }
}
