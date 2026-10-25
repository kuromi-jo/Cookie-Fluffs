/**
 * @file offline-menu-indicator.component.ts
 * @description Compact notice for cached or bundled read-only catalog data.
 */
import { Component, inject } from '@angular/core';
import { IonIcon } from '@ionic/angular';
import { ProductService } from '../core/product.service';

@Component({
  selector: 'app-offline-menu-indicator',
  imports: [IonIcon],
  template: `
    @if (products.usingFallback()) {
      <div class="offline-menu" role="status">
        <ion-icon name="cloud-offline-outline" aria-hidden="true"></ion-icon>
        <span><strong>Offline menu</strong> Prices and availability will be checked before ordering.</span>
      </div>
    }
  `,
  styles: [`
    .offline-menu {
      display: flex;
      align-items: center;
      gap: 8px;
      margin: 0 0 14px;
      padding: 9px 12px;
      border: 1px solid var(--cf-pink-border);
      border-radius: 12px;
      background: var(--cf-pink-soft);
      color: var(--cf-choco-medium);
      font-size: 0.76rem;
      line-height: 1.4;
    }

    ion-icon {
      flex: 0 0 auto;
      color: var(--cf-pink-deep);
      font-size: 18px;
    }

    strong {
      color: var(--cf-choco);
    }
  `],
})
export class OfflineMenuIndicatorComponent {
  readonly products = inject(ProductService);
}
