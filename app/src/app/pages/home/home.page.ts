/**
 * @file home.page.ts
 * @description Home tab. Shows the menu from Neon as soon as the app opens, grouped into
 * Promos, Best sellers and New arrivals. The full menu lives in the "All Cookies" tab.
 */
import { Component, computed, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import {
  IonButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonIcon,
  IonMenuButton,
  IonRefresher,
  IonRefresherContent,
  IonSkeletonText,
  IonToolbar,
  RefresherCustomEvent,
} from '@ionic/angular';
import { AuthService } from '../../core/auth.service';
import { CartService } from '../../core/cart.service';
import { ProductService } from '../../core/product.service';
import { ShopActionsService } from '../../core/shop-actions.service';
import { CATEGORIES, COLLECTIONS, Collection, Product, inCollection } from '../../core/models';
import { ProductCardComponent } from '../../components/product-card.component';

@Component({
  selector: 'app-home',
  templateUrl: 'home.page.html',
  styleUrls: ['../catalog.scss', 'home.page.scss'],
  imports: [
    RouterLink,
    IonHeader,
    IonToolbar,
    IonButtons,
    IonMenuButton,
    IonButton,
    IonIcon,
    IonContent,
    IonRefresher,
    IonRefresherContent,
    IonSkeletonText,
    ProductCardComponent,
  ],
})
export class HomePage {
  readonly auth = inject(AuthService);
  readonly cart = inject(CartService);
  readonly products = inject(ProductService);
  private shop = inject(ShopActionsService);

  /** Category shortcuts (without "All"); each opens the All Cookies tab pre-filtered. */
  readonly categories = CATEGORIES.filter((c) => c.id !== 'all');
  readonly skeletons = [1, 2, 3];

  private readonly hour = new Date().getHours();
  readonly greeting = this.hour < 12 ? 'Good morning' : this.hour < 18 ? 'Good afternoon' : 'Good evening';
  readonly greetingIcon = this.hour < 12 ? 'sunny-outline' : this.hour < 18 ? 'partly-sunny-outline' : 'moon-outline';

  /** Home sections, in display order. Empty sections are hidden. */
  readonly sections = computed(() =>
    (['promo', 'best', 'new'] as Collection[])
      .map((id) => ({
        id,
        ...COLLECTIONS[id],
        items: this.products.products().filter((p) => inCollection(p, id)),
      }))
      .filter((s) => s.items.length > 0),
  );

  readonly totalCount = computed(() => this.products.products().length);

  /** Four cookies peeking out of the build-a-box card. */
  readonly boxPreview = ['choco-chip', 'red-velvet', 'mango-pie', 'oreo-vanilla'].map(
    (slug) => `assets/cookies/thumbs/${slug}.webp`,
  );

  constructor() {
    void this.products.load();
  }

  async refresh(event: RefresherCustomEvent): Promise<void> {
    await this.products.load(true);
    if (this.auth.isLoggedIn()) await this.cart.load().catch(() => undefined);
    await event.target.complete();
  }

  retry(): void {
    void this.products.load(true);
  }

  buildBox(): void {
    this.shop.startBox(6);
  }

  addToCart(product: Product): void {
    void this.shop.choosePack(product);
  }
}
