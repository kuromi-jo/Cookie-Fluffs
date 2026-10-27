/**
 * @file home.page.ts
 * @description Home tab. Shows the menu from Neon as soon as the app opens, grouped into
 * Halloween specials, a cookie of the day, Order again and favorites for signed-in customers,
 * then Promos, Best sellers and New arrivals. The full menu lives in the "All Cookies" tab.
 */
import { Component, computed, effect, inject, signal } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { Router, RouterLink } from '@angular/router';
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
  IonSpinner,
  IonToolbar,
  RefresherCustomEvent,
} from '@ionic/angular';
import { AuthService } from '../../core/auth.service';
import { CartService } from '../../core/cart.service';
import { ProductService } from '../../core/product.service';
import { ShopActionsService } from '../../core/shop-actions.service';
import { FavoriteService } from '../../core/favorite.service';
import { OrderService } from '../../core/order.service';
import { UiService } from '../../core/ui.service';
import { apiErrorMessage } from '../../core/api-error';
import { CATEGORIES, COLLECTIONS, Collection, OrderSummary, Product, inCollection } from '../../core/models';
import { ProductCardComponent } from '../../components/product-card.component';
import { RailComponent } from '../../components/rail.component';
import { OfflineMenuIndicatorComponent } from '../../components/offline-menu-indicator.component';

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
    IonSpinner,
    DecimalPipe,
    ProductCardComponent,
    RailComponent,
    OfflineMenuIndicatorComponent,
  ],
})
export class HomePage {
  readonly auth = inject(AuthService);
  readonly cart = inject(CartService);
  readonly products = inject(ProductService);
  readonly favorites = inject(FavoriteService);
  private shop = inject(ShopActionsService);
  private ordersApi = inject(OrderService);
  private ui = inject(UiService);
  private router = inject(Router);

  /** The signed-in customer's most recent order, for the Order again card. */
  readonly lastOrder = signal<OrderSummary | null>(null);
  readonly reordering = signal(false);

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

  /** Seasonal Halloween bakes, promoted in their own band near the top. Hidden when empty. */
  readonly halloween = computed(() => this.products.products().filter((p) => inCollection(p, 'halloween')));
  /** Days until Oct 31 (0 on the day itself), or null once Halloween has passed. */
  readonly halloweenDaysLeft = daysUntilHalloween(new Date());

  /** Same pick for everyone all day; it changes at midnight. */
  readonly cookieOfTheDay = computed(() => {
    const menu = this.products.products().filter((p) => p.isAvailable);
    if (!menu.length) return null;
    const now = new Date();
    const day = Math.floor(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) / 86_400_000);
    return menu[day % menu.length];
  });

  readonly favoriteItems = computed(() => this.favorites.favorites().filter((p) => p.isAvailable));

  readonly totalCount = computed(() => this.products.products().length);

  /** Four cookies peeking out of the build-a-box card. */
  readonly boxPreview = ['choco-chip', 'red-velvet', 'mango-pie', 'oreo-vanilla'].map(
    (slug) => `assets/cookies/thumbs/${slug}.webp`,
  );

  constructor() {
    void this.products.load();
    effect(() => {
      if (this.auth.user()) void this.loadLastOrder();
      else this.lastOrder.set(null);
    });
  }

  async refresh(event: RefresherCustomEvent): Promise<void> {
    await this.products.load(true);
    if (this.auth.isLoggedIn()) {
      await this.cart.load().catch(() => undefined);
      await this.loadLastOrder();
    }
    await event.target.complete();
  }

  private async loadLastOrder(): Promise<void> {
    try {
      const page = await this.ordersApi.list(1);
      this.lastOrder.set(page.orders[0] ?? null);
    } catch {
      this.lastOrder.set(null);
    }
  }

  /** Puts the last order's cookies back in the cart (the server re-prices them), then opens the cart. */
  async reorderLast(order: OrderSummary): Promise<void> {
    if (this.reordering()) return;
    if (!this.products.online()) {
      void this.ui.toast('Reconnect to Cookie Fluffs before ordering again.', { error: true });
      return;
    }
    this.reordering.set(true);
    try {
      const result = await this.ordersApi.reorder(order.id);
      this.cart.replaceFromServer(result.cart);
      const message = result.unavailable.length
        ? 'Added to your cart. Some cookies are no longer available.'
        : 'Added your last order to your cart.';
      void this.ui.toast(message);
      void this.router.navigateByUrl('/cart');
    } catch (error) {
      void this.ui.toast(apiErrorMessage(error), { error: true });
    } finally {
      this.reordering.set(false);
    }
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

/** Whole days from today until Oct 31 of this year (0 on Halloween), or null after it. */
export function daysUntilHalloween(now: Date): number | null {
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  const halloween = Date.UTC(now.getFullYear(), 9, 31);
  const days = Math.round((halloween - today) / 86_400_000);
  return days >= 0 ? days : null;
}
