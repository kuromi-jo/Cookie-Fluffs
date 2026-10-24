/**
 * @file product-detail.page.ts
 * @description Full details for one cookie, with quantity picker and Add to cart.
 */
import { Component, computed, effect, inject, input, signal } from '@angular/core';
import { DecimalPipe, TitleCasePipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import {
  IonBackButton,
  IonBadge,
  IonButton,
  IonButtons,
  IonContent,
  IonFooter,
  IonHeader,
  IonIcon,
  IonSpinner,
  IonToolbar,
} from '@ionic/angular';
import { CartService } from '../../core/cart.service';
import { ProductService } from '../../core/product.service';
import { ShopActionsService } from '../../core/shop-actions.service';
import { apiErrorMessage } from '../../core/api-error';
import { BoxSize, PackSize, Product, discountPercent, effectivePrice, thumbUrl } from '../../core/models';
import { PackOptionsComponent } from '../../components/pack-options.component';
import { FavoriteService } from '../../core/favorite.service';

@Component({
  selector: 'app-product-detail',
  templateUrl: 'product-detail.page.html',
  styleUrls: ['product-detail.page.scss'],
  imports: [
    RouterLink,
    DecimalPipe,
    TitleCasePipe,
    IonHeader,
    IonToolbar,
    IonButtons,
    IonBackButton,
    IonButton,
    IonIcon,
    IonBadge,
    IonContent,
    IonFooter,
    IonSpinner,
    PackOptionsComponent,
  ],
})
export class ProductDetailPage {
  /** Route parameter :id (bound by withComponentInputBinding). */
  readonly id = input.required<string>();

  readonly cart = inject(CartService);
  readonly favorites = inject(FavoriteService);
  private products = inject(ProductService);
  private shop = inject(ShopActionsService);

  readonly product = signal<Product | null>(null);
  readonly error = signal<string | null>(null);
  readonly qty = signal(1);
  readonly pack = signal<PackSize>(1);
  readonly thumb = thumbUrl;
  readonly discount = computed(() => {
    const p = this.product();
    return p ? discountPercent(p) : 0;
  });
  readonly adding = signal(false);

  readonly total = computed(() => {
    const p = this.product();
    return p ? effectivePrice(p) * this.qty() : 0;
  });
  readonly inCart = computed(() => {
    const p = this.product();
    return p ? this.cart.quantityOf(p.id) : 0;
  });

  readonly related = computed(() => {
    const p = this.product();
    if (!p) return [];
    return this.products
      .products()
      .filter((x) => x.id !== p.id && x.category === p.category)
      .concat(this.products.products().filter((x) => x.id !== p.id && x.category !== p.category))
      .slice(0, 4);
  });

  constructor() {
    effect(() => {
      const id = Number(this.id());
      this.product.set(null);
      this.error.set(null);
      this.qty.set(1);
      this.pack.set(1);
      this.products
        .getById(id)
        .then((p) => this.product.set(p))
        .catch((err) => this.error.set(apiErrorMessage(err)));
    });
    void this.products.load();
  }

  stars(rating: number): string[] {
    return [1, 2, 3, 4, 5].map((n) => (rating >= n - 0.25 ? 'star' : rating >= n - 0.75 ? 'star-half' : 'star-outline'));
  }

  changeQty(delta: number): void {
    this.qty.update((q) => Math.min(20, Math.max(1, q + delta)));
  }

  buildBox(): void {
    const p = this.product();
    if (p) this.shop.startBox(this.pack() as BoxSize, p);
  }

  async add(): Promise<void> {
    const p = this.product();
    if (!p || !p.isAvailable) return;
    this.adding.set(true);
    const ok = await this.shop.addSingle(p, this.qty());
    this.adding.set(false);
    if (ok) this.qty.set(1);
  }

  saveFavorite(product: Product): void {
    void this.favorites.toggle(product);
  }
}
