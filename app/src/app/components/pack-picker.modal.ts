/**
 * @file pack-picker.modal.ts
 * @description Bottom sheet shown when tapping the cart button on a cookie:
 * pick Single (with quantity) or a 4 / 6 / 12 box to build.
 */
import { Component, computed, inject, input, signal } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { IonButton, IonContent, IonFooter, IonIcon, ModalController } from '@ionic/angular';
import { PackSize, Product, effectivePrice } from '../core/models';
import { PackOptionsComponent } from './pack-options.component';
import { PhotoPipe } from '../core/photo.pipe';
import { AsyncPipe } from '@angular/common';

export interface PackChoice {
  size: PackSize;
  quantity: number;
}

export const PACK_PICKER_BREAKPOINTS = [0, 1];
export const PACK_PICKER_INITIAL_BREAKPOINT = 1;

@Component({
  selector: 'app-pack-picker',
  imports: [PhotoPipe, AsyncPipe, DecimalPipe, IonContent, IonFooter, IonButton, IonIcon, PackOptionsComponent],
  template: `
    <ion-content class="sheet">
      <div class="wrap">
        <header>
          <img [src]="product().imageUrl | cfPhoto | async" [alt]="product().name" />
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

      </div>
    </ion-content>
    <ion-footer class="sheet-footer">
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
    </ion-footer>
  `,
  styles: `
    .sheet { --background: var(--cf-canvas); }
    .wrap { box-sizing: border-box; width: 100%; min-width: 0; padding: 8px 18px 18px; }
    header { display: flex; align-items: center; gap: 12px; margin-bottom: 14px; }
    header img { width: 64px; height: 64px; object-fit: contain; flex: none; }
    header div { flex: 1; min-width: 0; }
    header h2 { margin: 2px 0 0; font-size: 1.2rem; font-weight: 800; }
    header p { margin: 2px 0 0; font-size: .76rem; font-weight: 600; color: var(--cf-choco-light); }
    .close {
      display: grid; place-items: center; width: 44px; height: 44px; flex: none; border: 0; border-radius: 50%;
      background: var(--cf-pink-soft); color: var(--cf-choco); font-size: 18px; cursor: pointer;
    }
    .sheet-footer { background: var(--cf-canvas); box-shadow: none; }
    .sheet-footer::before { display: none; }
    footer {
      display: flex; align-items: center; gap: 10px; min-width: 0; padding: 10px 18px calc(12px + env(safe-area-inset-bottom));
      border-top: 1px solid var(--cf-pink-border); background: var(--cf-canvas);
    }
    .action { flex: 1; min-width: 0; margin: 0; font-size: .82rem; }
    .stepper { display: flex; align-items: center; gap: 4px; padding: 4px; border-radius: 999px; background: var(--cf-pink-soft); }
    .stepper button {
      display: grid; place-items: center; width: 38px; height: 38px; border: 0; border-radius: 50%;
      background: #fff; color: var(--cf-choco); font-size: 18px; cursor: pointer;
    }
    .stepper button:disabled { opacity: .4; }
    .stepper span { min-width: 26px; text-align: center; font-weight: 800; }
    @media (max-width: 340px) {
      .wrap { padding-inline: 14px; }
      header { gap: 9px; }
      header img { width: 56px; height: 56px; }
      header h2 { font-size: 1.08rem; }
      footer { padding-inline: 14px; }
      .stepper button { width: 36px; height: 36px; }
      .stepper span { min-width: 22px; }
      .action { font-size: .76rem; }
    }
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
