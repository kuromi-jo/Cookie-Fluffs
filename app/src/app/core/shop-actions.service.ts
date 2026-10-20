/**
 * @file shop-actions.service.ts
 * @description Add-to-cart flows shared by every screen:
 *  - choosePack(): the "Single / Box of 4 / 6 / 12" sheet
 *  - addSingle(): single cookies straight to the cart
 *  - startBox():  opens the box builder with the first cookie already inside
 *  - addBox():    puts a finished box in the cart
 * Guests are asked to log in before anything is saved, since each cart belongs to an account.
 */
import { Injectable, inject } from '@angular/core';
import { Router } from '@angular/router';
import { AlertController, ModalController } from '@ionic/angular';
import { AuthService } from './auth.service';
import { CartService } from './cart.service';
import { BoxBuilderService } from './box-builder.service';
import { UiService } from './ui.service';
import { apiErrorMessage } from './api-error';
import { BoxSize, Product } from './models';
import { PackChoice, PackPickerModal } from '../components/pack-picker.modal';

@Injectable({ providedIn: 'root' })
export class ShopActionsService {
  private auth = inject(AuthService);
  private cart = inject(CartService);
  private builder = inject(BoxBuilderService);
  private ui = inject(UiService);
  private router = inject(Router);
  private alerts = inject(AlertController);
  private modals = inject(ModalController);

  /** The cart button on a cookie: ask how many, then add or start a box. */
  async choosePack(product: Product): Promise<void> {
    const sheet = await this.modals.create({
      component: PackPickerModal,
      componentProps: { product },
      breakpoints: [0, 0.72, 0.92],
      initialBreakpoint: 0.72,
      handleBehavior: 'cycle',
      cssClass: 'cf-sheet',
    });
    await sheet.present();
    const { data, role } = await sheet.onWillDismiss<PackChoice>();
    if (role !== 'confirm' || !data) return;
    if (data.size === 1) await this.addSingle(product, data.quantity);
    else this.startBox(data.size, product);
  }

  async addSingle(product: Product, quantity = 1): Promise<boolean> {
    if (!this.auth.isLoggedIn()) {
      await this.askToLogin();
      return false;
    }
    try {
      await this.cart.add(product.id, quantity);
      void this.ui.toast(`${quantity > 1 ? quantity + ' × ' : ''}${product.name} added to your cart`, {
        icon: 'cart-outline',
        buttons: [{ text: 'View', handler: () => void this.router.navigateByUrl('/cart') }],
      });
      return true;
    } catch (err) {
      await this.ui.toast(apiErrorMessage(err), { error: true });
      return false;
    }
  }

  /** Opens the box builder with a fresh box. Building works for guests; saving asks them to log in. */
  startBox(size: BoxSize, first?: Product): void {
    this.builder.start(size, first);
    void this.router.navigate(['/box']);
  }

  /** Saves the finished box to the cart. */
  async addBox(): Promise<boolean> {
    if (!this.builder.isFull()) return false;
    if (!this.auth.isLoggedIn()) {
      await this.askToLogin('/box');
      return false;
    }
    try {
      await this.cart.addBox(this.builder.size(), this.builder.productIds());
      void this.ui.toast(`Box of ${this.builder.size()} added to your cart`, {
        icon: 'cube-outline',
        buttons: [{ text: 'View', handler: () => void this.router.navigateByUrl('/cart') }],
      });
      this.builder.clear();
      return true;
    } catch (err) {
      await this.ui.toast(apiErrorMessage(err), { error: true });
      return false;
    }
  }

  private async askToLogin(returnTo?: string): Promise<void> {
    const returnUrl = returnTo ?? this.router.url.split('?')[0];
    const alert = await this.alerts.create({
      header: 'Log in to order',
      message: 'Your cart is saved to your Cookie Fluffs account, so you can pick up right where you left off.',
      buttons: [
        { text: 'Keep browsing', role: 'cancel' },
        { text: 'Log in', handler: () => void this.router.navigate(['/login'], { queryParams: { returnUrl } }) },
      ],
    });
    await alert.present();
  }
}
