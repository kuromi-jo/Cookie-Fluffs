/**
 * @file tabs.page.ts
 * @description Bottom tab bar: Home (featured sections), All Cookies (full menu) and Cart.
 * Each tab keeps its own navigation stack, like a native shopping app.
 */
import { Component, inject } from '@angular/core';
import { IonBadge, IonIcon, IonLabel, IonTabBar, IonTabButton, IonTabs } from '@ionic/angular';
import { CartService } from '../../core/cart.service';

@Component({
  selector: 'app-tabs',
  imports: [IonTabs, IonTabBar, IonTabButton, IonIcon, IonLabel, IonBadge],
  template: `
    <ion-tabs>
      <ion-tab-bar slot="bottom" class="cf-tab-bar">
        <ion-tab-button tab="home">
          <ion-icon name="home-outline" aria-hidden="true"></ion-icon>
          <ion-label>Home</ion-label>
        </ion-tab-button>
        <ion-tab-button tab="shop">
          <ion-icon name="cf-cookie" aria-hidden="true"></ion-icon>
          <ion-label>All Cookies</ion-label>
        </ion-tab-button>
        <ion-tab-button tab="cart">
          <ion-icon name="cart-outline" aria-hidden="true"></ion-icon>
          <ion-label>Cart</ion-label>
          @if (cart.count() > 0) {
            <ion-badge>{{ cart.count() }}</ion-badge>
          }
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
      height: 64px;
      padding-bottom: env(safe-area-inset-bottom);
      border-top: 1px solid var(--cf-pink-soft);
    }
    ion-tab-button {
      --ripple-color: var(--cf-pink-accent);
      font-weight: 700;
    }
    ion-tab-button ion-icon { font-size: 23px; }
    ion-tab-button ion-label { margin-top: 3px; font-size: 0.68rem; letter-spacing: 0.01em; }
    ion-tab-button.tab-selected ion-icon { transform: translateY(-1px); }
    ion-badge {
      --background: var(--cf-pink-vibrant);
      --color: #fff;
      --padding-start: 5px;
      --padding-end: 5px;
      min-width: 18px;
      border-radius: 999px;
      font-size: 0.62rem;
      font-weight: 800;
    }
  `,
})
export class TabsPage {
  readonly cart = inject(CartService);
}
