/**
 * @file pack-picker.modal.ts
 * @description Bottom sheet shown when tapping the cart button on a cookie:
 * pick Single (with quantity) or a 4 / 6 / 12 box to build.
 */
import { Component, computed, inject, input, signal } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { IonButton, IonContent, IonIcon, ModalController } from '@ionic/angular';
import { PackSize, Product, effectivePrice } from '../core/models';
import { PackOptionsComponent } from './pack-options.component';

export interface PackChoice {
  size: PackSize;
  quantity: number;
}

@Component({
  selector: 'app-pack-picker',
  imports: [DecimalPipe, IonContent, IonButton, IonIcon, PackOptionsComponent],
  template: `
    <ion-content class="sheet">
      <div class="wrap">
        <header>
          <img [src]="product().imageUrl" [alt]="product().name" />
          <div>
            <span class="cf-eyebrow">Add to cart</span>
            <h2>{{ product().name }}</h2>
            <p>{{ product().flavorNotes }}</p>
          </div>
          <button type="button" class="close" (click)="close()" aria-label="Close">
            <ion-icon name="close"></ion-icon>
          </button>
        </header>

        <app-pack-options [product]="product()" [(selected)]="size" />

        <footer>
          @if (size() === 1) {
            <div class="stepper" role="group" aria-label="Quantity">
              <button type="button" (click)="change(-1)" [disabled]="qty() <= 1" aria-label="Fewer">
                <ion-icon name="remove"></ion-icon>
              </button>
              <span aria-live="polite">{{ qty() }}</span>
              <button type="button" (click)="change(1)" [disabled]="qty() >= 20" aria-label="More">
                <ion-icon name="add"></ion-icon>
              </button>
            </div>
            <ion-button class="cf-btn-lg action" (click)="confirm()">
              <ion-icon slot="start" name="cart-outline"></ion-icon>
              Add · ₱{{ singleTotal() | number: '1.0-0' }}
            </ion-button>
          } @else {
            <ion-button class="cf-btn-lg action" expand="block" (click)="confirm()">
              <ion-icon slot="start" name="cube-outline"></ion-icon>
              Build your box of {{ size() }}
            </ion-button>
          }
        </footer>
      </div>
    </ion-content>
  `,
  styles: `
    .sheet { --background: var(--cf-canvas); }
    .wrap { padding: 8px 18px 18px; }
    header { display: flex; align-items: center; gap: 12px; margin-bottom: 14px; }
    header img { width: 64px; height: 64px; object-fit: contain; flex: none; }
    header div { flex: 1; min-width: 0; }
    header h2 { margin: 2px 0 0; font-size: 1.2rem; font-weight: 800; }
    header p { margin: 2px 0 0; font-size: .76rem; font-weight: 600; color: var(--cf-choco-light); }
    .close {
      display: grid; place-items: center; width: 36px; height: 36px; flex: none; border: 0; border-radius: 50%;
      background: var(--cf-pink-soft); color: var(--cf-choco); font-size: 18px; cursor: pointer;
    }
    footer { display: flex; align-items: center; gap: 12px; margin-top: 16px; }
    .action { flex: 1; margin: 0; }
    .stepper { display: flex; align-items: center; gap: 4px; padding: 4px; border-radius: 999px; background: var(--cf-pink-soft); }
    .stepper button {
      display: grid; place-items: center; width: 38px; height: 38px; border: 0; border-radius: 50%;
      background: #fff; color: var(--cf-choco); font-size: 18px; cursor: pointer;
    }
    .stepper button:disabled { opacity: .4; }
    .stepper span { min-width: 26px; text-align: center; font-weight: 800; }
  `,
})
export class PackPickerComponent {
  readonly product = input.required<Product>();

  private modal = inject(ModalController);

  readonly size = signal<PackSize>(1);
  readonly qty = signal(1);
  readonly singleTotal = computed(() => effectivePrice(this.product()) * this.qty());

  change(delta: number): void {
    this.qty.update((q) => Math.min(20, Math.max(1, q + delta)));
  }

  confirm(): void {
    const choice: PackChoice = { size: this.size(), quantity: this.size() === 1 ? this.qty() : 1 };
    void this.modal.dismiss(choice, 'confirm');
  }

  close(): void {
    void this.modal.dismiss(null, 'cancel');
  }
}

export { PackPickerComponent as PackPickerModal };
