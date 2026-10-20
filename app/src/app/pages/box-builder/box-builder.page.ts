/**
 * @file box-builder.page.ts
 * @description Mix-and-match box builder. An open pink box with 4, 6 or 12 spots:
 * tap a cookie below to drop it into the next empty spot, tap a cookie in the box to take it out.
 */
import { Component, computed, inject, signal } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { Router } from '@angular/router';
import {
  IonBackButton,
  IonButton,
  IonButtons,
  IonContent,
  IonFooter,
  IonHeader,
  IonIcon,
  IonSpinner,
  IonTitle,
  IonToolbar,
} from '@ionic/angular';
import { BoxBuilderService } from '../../core/box-builder.service';
import { ProductService } from '../../core/product.service';
import { ShopActionsService } from '../../core/shop-actions.service';
import { UiService } from '../../core/ui.service';
import { BoxSize, CATEGORIES, CookieCategory, PACK_OPTIONS, Product, effectivePrice, thumbUrl } from '../../core/models';

/** Small fixed tilt per spot so the cookies look hand-placed. */
const TILTS = [-8, 6, -3, 9, -6, 4, 7, -9, 2, -4, 8, -2];

@Component({
  selector: 'app-box-builder',
  templateUrl: 'box-builder.page.html',
  styleUrls: ['box-builder.page.scss'],
  imports: [
    DecimalPipe,
    IonHeader,
    IonToolbar,
    IonButtons,
    IonBackButton,
    IonTitle,
    IonButton,
    IonContent,
    IonFooter,
    IonIcon,
    IonSpinner,
  ],
})
export class BoxBuilderPage {
  readonly box = inject(BoxBuilderService);
  readonly products = inject(ProductService);
  private shop = inject(ShopActionsService);
  private ui = inject(UiService);
  private router = inject(Router);

  readonly sizes = PACK_OPTIONS.filter((o) => o.size !== 1);
  readonly categories = CATEGORIES;
  readonly category = signal<CookieCategory | 'all'>('all');
  readonly adding = signal(false);
  readonly thumb = thumbUrl;
  readonly tilts = TILTS;
  readonly price = effectivePrice;

  readonly menu = computed(() =>
    this.products.products().filter((p) => this.category() === 'all' || p.category === this.category()),
  );

  /** How many of each cookie are in the box, for the little counters on the picker. */
  readonly counts = computed(() => {
    const map = new Map<number, number>();
    for (const p of this.box.filled()) map.set(p.id, (map.get(p.id) ?? 0) + 1);
    return map;
  });

  constructor() {
    void this.products.load();
  }

  setSize(size: BoxSize): void {
    if (size !== this.box.size()) this.box.resize(size);
  }

  pick(p: Product): void {
    if (!this.box.add(p)) {
      void this.ui.toast(`Your box of ${this.box.size()} is full. Tap a cookie in the box to swap it out.`, {
        icon: 'cube-outline',
      });
    }
  }

  surprise(): void {
    this.box.surprise(this.products.products());
  }

  async addToCart(): Promise<void> {
    this.adding.set(true);
    const ok = await this.shop.addBox();
    this.adding.set(false);
    if (ok) void this.router.navigateByUrl('/cart');
  }
}
