/**
 * @file cart.page.ts
 * @description Shopping cart: view items, change quantities, remove, and see totals.
 */
import { Component, computed, inject, signal } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { Router, RouterLink } from '@angular/router';
import {
  AlertController,
  IonButton,
  IonButtons,
  IonContent,
  IonFooter,
  IonHeader,
  IonIcon,
  IonItem,
  IonItemOption,
  IonItemOptions,
  IonItemSliding,
  IonList,
  IonMenuButton,
  IonSpinner,
  IonTitle,
  IonToolbar,
} from '@ionic/angular';
import { AuthService } from '../../core/auth.service';
import { CartService } from '../../core/cart.service';
import { UiService } from '../../core/ui.service';
import { apiErrorMessage } from '../../core/api-error';
import { CartBox, CartItem, thumbUrl } from '../../core/models';
import { ShopActionsService } from '../../core/shop-actions.service';
import { checkoutAccess } from '../../core/checkout-rules';
import { PhotoPipe } from '../../core/photo.pipe';
import { AsyncPipe } from '@angular/common';

@Component({
  selector: 'app-cart',
  templateUrl: 'cart.page.html',
  styleUrls: ['cart.page.scss'],
  imports: [PhotoPipe, AsyncPipe, 
    RouterLink,
    DecimalPipe,
    IonHeader,
    IonToolbar,
    IonButtons,
    IonMenuButton,
    IonTitle,
    IonButton,
    IonIcon,
    IonContent,
    IonList,
    IonItemSliding,
    IonItem,
    IonItemOptions,
    IonItemOption,
    IonFooter,
    IonSpinner,
  ],
})
export class CartPage {
  readonly auth = inject(AuthService);
  readonly cartService = inject(CartService);
  private ui = inject(UiService);
  private alerts = inject(AlertController);
  private router = inject(Router);
  private shop = inject(ShopActionsService);

  readonly cart = this.cartService.cart;

  readonly toFreeDelivery = computed(() => Math.max(0, this.cart().freeDeliveryMin - this.cart().subtotal));
  readonly freeDeliveryProgress = computed(() =>
    Math.min(100, Math.round((this.cart().subtotal / this.cart().freeDeliveryMin) * 100)),
  );

  /** Singles and boxes together, for the checkboxes. */
  private readonly lines = computed(() => [...this.cart().items, ...this.cart().boxes]);
  readonly lineCount = computed(() => this.lines().length);
  readonly allSelected = computed(() => this.lineCount() > 0 && this.lines().every((l) => l.selected));
  readonly someSelected = computed(() => this.lines().some((l) => l.selected));
  readonly thumb = thumbUrl;
  readonly selectingAll = signal(false);

  ionViewWillEnter(): void {
    if (this.auth.isLoggedIn()) void this.cartService.load().catch((err) => this.fail(err));
  }

  login(): void {
    void this.router.navigate(['/login'], { queryParams: { returnUrl: '/cart' } });
  }

  async change(item: CartItem, delta: number): Promise<void> {
    const next = item.quantity + delta;
    if (next < 1) return this.remove(item);
    try {
      await this.cartService.setQuantity(item.productId, next);
    } catch (err) {
      await this.fail(err);
    }
  }

  /** Tick / untick one cookie. Only ticked cookies go to checkout. */
  async toggle(item: CartItem): Promise<void> {
    try {
      await this.cartService.setSelected(item.productId, !item.selected);
    } catch (err) {
      await this.fail(err);
    }
  }

  async toggleAll(): Promise<void> {
    this.selectingAll.set(true);
    try {
      await this.cartService.selectAll(!this.allSelected());
    } catch (err) {
      await this.fail(err);
    } finally {
      this.selectingAll.set(false);
    }
  }

  async remove(item: CartItem, sliding?: IonItemSliding): Promise<void> {
    await sliding?.close();
    try {
      await this.cartService.remove(item.productId);
      await this.ui.toast(`${item.name} removed`, { icon: 'trash-outline' });
    } catch (err) {
      await this.fail(err);
    }
  }

  /* ---------- boxes ---------- */

  async toggleBox(box: CartBox): Promise<void> {
    try {
      await this.cartService.setBoxSelected(box.id, !box.selected);
    } catch (err) {
      await this.fail(err);
    }
  }

  async changeBox(box: CartBox, delta: number): Promise<void> {
    const next = box.quantity + delta;
    if (next < 1) return this.removeBox(box);
    try {
      await this.cartService.setBoxQuantity(box.id, next);
    } catch (err) {
      await this.fail(err);
    }
  }

  async removeBox(box: CartBox, sliding?: IonItemSliding): Promise<void> {
    await sliding?.close();
    try {
      await this.cartService.removeBox(box.id);
      await this.ui.toast(`Box of ${box.size} removed`, { icon: 'trash-outline' });
    } catch (err) {
      await this.fail(err);
    }
  }

  buildBox(): void {
    this.shop.startBox(6);
  }

  /** "2× Classic Choco Chip, Mango Pie, Key Lime Cream" */
  boxSummary(box: CartBox): string {
    const counts = new Map<string, number>();
    for (const c of box.cookies) counts.set(c.name, (counts.get(c.name) ?? 0) + 1);
    return [...counts].map(([name, n]) => (n > 1 ? `${n}× ${name}` : name)).join(', ');
  }

  async confirmClear(): Promise<void> {
    const alert = await this.alerts.create({
      header: 'Empty your cart?',
      message: 'This removes every cookie and box from your cart.',
      cssClass: 'cf-alert-confirm',
      // The safe choice (keep) is the emphasized button; emptying is the quiet one.
      buttons: [
        {
          text: 'Empty cart',
          role: 'destructive',
          cssClass: 'alert-btn-quiet',
          handler: () => {
            this.cartService
              .clear()
              .then(() => this.ui.toast('Your cart is now empty', { icon: 'trash-outline' }))
              .catch((err) => this.fail(err));
          },
        },
        { text: 'Keep items', role: 'cancel', cssClass: 'alert-btn-primary' },
      ],
    });
    await alert.present();
  }

  async checkout(): Promise<void> {
    const access = checkoutAccess(this.auth.isLoggedIn(), this.cart().selectedCount);
    if (access === 'login') {
      await this.router.navigate(['/login'], { queryParams: { returnUrl: '/checkout' } });
      return;
    }
    if (access === 'cart') {
      await this.ui.toast('Select at least one cart item before checkout.', { error: true });
      return;
    }
    await this.router.navigate(['/checkout']);
  }

  private fail(err: unknown): Promise<void> {
    return this.ui.toast(apiErrorMessage(err), { error: true });
  }
}
