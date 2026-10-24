/**
 * @file tabs.page.ts
 * @description Persistent five-destination customer navigation with cart state and nested-route highlighting.
 */
import { Component, computed, inject } from '@angular/core';
import { NavigationEnd, Router, RouterLink } from '@angular/router';
import { toSignal } from '@angular/core/rxjs-interop';
import { filter, map } from 'rxjs';
import { IonBadge, IonIcon, IonLabel, IonTabBar, IonTabButton, IonTabs } from '@ionic/angular';
import { CartService } from '../../core/cart.service';

export type NavigationTab = 'home' | 'shop' | 'favorites' | 'cart' | 'account';

export function navigationTabForPath(url: string): NavigationTab {
  const path = url.split('?')[0].split('#')[0];
  if (path === '/profile/favorites') return 'favorites';
  if (path === '/cart') return 'cart';
  if (path === '/shop' || path.startsWith('/product/')) return 'shop';
  if (path === '/profile' || path.startsWith('/profile/') || path === '/orders'
    || path.startsWith('/orders/') || path === '/help' || path.startsWith('/help/')) return 'account';
  return 'home';
}

@Component({
  selector: 'app-tabs',
  imports: [RouterLink, IonTabs, IonTabBar, IonTabButton, IonIcon, IonLabel, IonBadge],
  template: `
    <ion-tabs>
      <ion-tab-bar slot="bottom" class="cf-tab-bar">
        <ion-tab-button data-tab="home" routerLink="/home" [class.is-active]="activeTab() === 'home'" [attr.aria-current]="activeTab() === 'home' ? 'page' : null">
          <ion-icon name="home-outline" aria-hidden="true"></ion-icon>
          <ion-label>Home</ion-label>
        </ion-tab-button>
        <ion-tab-button data-tab="shop" routerLink="/shop" [class.is-active]="activeTab() === 'shop'" [attr.aria-current]="activeTab() === 'shop' ? 'page' : null">
          <ion-icon name="cf-cookie" aria-hidden="true"></ion-icon>
          <ion-label>All Cookies</ion-label>
        </ion-tab-button>
        <ion-tab-button data-tab="favorites" routerLink="/profile/favorites" [class.is-active]="activeTab() === 'favorites'" [attr.aria-current]="activeTab() === 'favorites' ? 'page' : null">
          <ion-icon name="heart-outline" aria-hidden="true"></ion-icon>
          <ion-label>Favorites</ion-label>
        </ion-tab-button>
        <ion-tab-button data-tab="cart" routerLink="/cart" [class.is-active]="activeTab() === 'cart'" [attr.aria-current]="activeTab() === 'cart' ? 'page' : null">
          <ion-icon name="cart-outline" aria-hidden="true"></ion-icon>
          <ion-label>Cart</ion-label>
          @if (cart.count() > 0) {
            <ion-badge>{{ cart.count() }}</ion-badge>
          }
        </ion-tab-button>
        <ion-tab-button data-tab="account" routerLink="/profile" [class.is-active]="activeTab() === 'account'" [attr.aria-current]="activeTab() === 'account' ? 'page' : null">
          <ion-icon name="person-outline" aria-hidden="true"></ion-icon>
          <ion-label>Account</ion-label>
        </ion-tab-button>
      </ion-tab-bar>
    </ion-tabs>
  `,
  styles: `
    .cf-tab-bar {
      --background: #ffffff;
      --border: 0;
      --color: var(--cf-choco-light);
      --color-selected: var(--cf-pink-deep);
      height: calc(68px + env(safe-area-inset-bottom));
      padding: 4px 0 env(safe-area-inset-bottom);
      border-top: 1px solid var(--cf-pink-soft);
    }
    ion-tab-button {
      --ripple-color: var(--cf-pink-accent);
      --padding-start: 0;
      --padding-end: 0;
      position: relative;
      min-width: 0;
      min-height: 60px;
      font-weight: 700;
    }
    ion-tab-button ion-icon {
      box-sizing: content-box;
      width: 21px;
      height: 21px;
      padding: 4px 9px;
      border-radius: 999px;
      font-size: 21px;
    }
    ion-tab-button ion-label {
      max-width: 100%;
      margin-top: 1px;
      overflow: hidden;
      font-size: clamp(0.56rem, 2.45vw, 0.66rem);
      letter-spacing: 0;
      text-overflow: clip;
      white-space: nowrap;
    }
    ion-tab-button.is-active { --color: var(--cf-pink-deep); }
    ion-tab-button.is-active ion-icon { background: var(--cf-pink-soft); color: var(--cf-pink-deep); }
    ion-badge {
      --background: var(--cf-pink-vibrant);
      --color: #fff;
      --padding-start: 5px;
      --padding-end: 5px;
      position: absolute;
      top: 3px;
      left: calc(50% + 7px);
      min-width: 18px;
      border-radius: 999px;
      font-size: 0.62rem;
      font-weight: 800;
    }
  `,
})
export class TabsPage {
  readonly cart = inject(CartService);
  private router = inject(Router);
  private readonly currentUrl = toSignal(
    this.router.events.pipe(
      filter((event): event is NavigationEnd => event instanceof NavigationEnd),
      map((event) => event.urlAfterRedirects),
    ),
    { initialValue: this.router.url },
  );
  readonly activeTab = computed(() => navigationTabForPath(this.currentUrl()));
}
