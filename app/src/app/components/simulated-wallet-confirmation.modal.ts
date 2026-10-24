/**
 * @file simulated-wallet-confirmation.modal.ts
 * @description Accessible in-app confirmation sheet for financially isolated wallet demonstrations.
 */
import { DecimalPipe } from '@angular/common';
import { Component, HostListener, Input, inject } from '@angular/core';
import {
  IonButton,
  IonButtons,
  IonContent,
  IonFooter,
  IonHeader,
  IonIcon,
  IonTitle,
  IonToolbar,
  ModalController,
} from '@ionic/angular';
import { WalletDemoAction } from '../core/models';

@Component({
  selector: 'app-simulated-wallet-confirmation',
  imports: [DecimalPipe, IonHeader, IonToolbar, IonTitle, IonButtons, IonButton, IonIcon, IonContent, IonFooter],
  template: `
    <ion-header class="cf-header">
      <ion-toolbar>
        <ion-title class="cf-title">Confirm test payment</ion-title>
        <ion-buttons slot="end">
          <ion-button class="close" fill="clear" aria-label="Close wallet confirmation" (click)="close()">
            <ion-icon slot="icon-only" name="close" aria-hidden="true"></ion-icon>
          </ion-button>
        </ion-buttons>
      </ion-toolbar>
    </ion-header>
    <ion-content>
      <div class="wallet-body">
        <span class="wallet-mark"><ion-icon name="wallet-outline" aria-hidden="true"></ion-icon></span>
        <p class="cf-eyebrow">{{ walletLabel }}</p>
        <h2>Review wallet payment</h2>
        <div class="payment-details">
          <div><span>Order</span><strong>#{{ orderReference }}</strong></div>
          <div><span>Amount</span><strong>₱{{ amount | number: '1.2-2' }}</strong></div>
        </div>
        <div class="simulation-note" role="note">
          <ion-icon name="information-circle-outline" aria-hidden="true"></ion-icon>
          <span>Test wallet payment only. Do not enter wallet credentials. No money will be transferred.</span>
        </div>
      </div>
    </ion-content>
    <ion-footer>
      <div class="wallet-actions">
        <ion-button class="cf-btn-lg" expand="block" (click)="finish('confirm')">Confirm test payment</ion-button>
        <ion-button fill="clear" expand="block" (click)="finish('cancel')">Cancel</ion-button>
      </div>
    </ion-footer>
  `,
  styles: `
    :host { display: flex; flex-direction: column; height: 100%; background: var(--cf-canvas); }
    ion-content { --background: var(--cf-canvas); }
    ion-footer { background: #fff; box-shadow: none; }
    .close { width: 44px; height: 44px; --padding-start: 0; --padding-end: 0; }
    .wallet-body { display: grid; justify-items: center; padding: 28px 20px 24px; text-align: center; }
    .wallet-mark { display: grid; place-items: center; width: 64px; height: 64px; margin-bottom: 14px; border: 1px solid var(--cf-pink-border); border-radius: 50%; background: var(--cf-pink-soft); color: var(--cf-pink-deep); font-size: 28px; }
    h2 { margin: 5px 0 18px; font-family: var(--cf-font-display); font-size: 1.55rem; color: var(--cf-choco); }
    .payment-details { width: 100%; max-width: 320px; padding: 4px 16px; border: 1px solid var(--cf-pink-border); border-radius: var(--cf-radius); background: #fff; }
    .payment-details div { display: flex; justify-content: space-between; gap: 16px; padding: 13px 0; color: var(--cf-choco-medium); font-size: .8rem; }
    .payment-details div + div { border-top: 1px solid var(--cf-pink-soft); }
    .payment-details strong { color: var(--cf-choco); }
    .simulation-note { display: flex; align-items: flex-start; gap: 8px; max-width: 320px; margin-top: 16px; padding: 13px 14px; border: 1px solid var(--cf-pink-border); border-radius: var(--cf-radius-sm); background: var(--cf-pink-soft); color: var(--cf-choco-light); font-size: .74rem; line-height: 1.45; text-align: left; }
    .simulation-note ion-icon { flex: none; margin-top: 2px; color: var(--cf-pink-deep); }
    .wallet-actions { display: grid; gap: 6px; padding: 12px 20px calc(14px + var(--ion-safe-area-bottom)); border-top: 1px solid var(--cf-pink-border); }
    .wallet-actions ion-button { min-height: 44px; margin: 0; }
    @media (max-width: 340px) { .wallet-body, .wallet-actions { padding-right: 14px; padding-left: 14px; } }
    @media (prefers-reduced-motion: reduce) { :host { scroll-behavior: auto; } }
  `,
})
export class SimulatedWalletConfirmationModalComponent {
  @Input({ required: true }) walletLabel = '';
  @Input({ required: true }) orderReference = '';
  @Input({ required: true }) amount = 0;
  private readonly modal = inject(ModalController);
  private closing = false;

  @HostListener('document:keydown.escape', ['$event'])
  closeOnEscape(event: Event): void {
    event.preventDefault();
    event.stopPropagation();
    this.close();
  }

  finish(action: WalletDemoAction): void {
    if (this.closing) return;
    this.closing = true;
    void this.modal.dismiss({ action }, action);
  }

  close(): void {
    if (this.closing) return;
    this.closing = true;
    void this.modal.dismiss(null, 'cancel');
  }
}

export async function presentSimulatedWalletConfirmation(
  modals: ModalController,
  options: { walletLabel: string; orderReference: string; amount: number },
): Promise<WalletDemoAction | null> {
  const modal = await modals.create({
    component: SimulatedWalletConfirmationModalComponent,
    componentProps: options,
    cssClass: 'cf-sheet',
    initialBreakpoint: 0.72,
    breakpoints: [0, 0.72, 1],
    backdropDismiss: true,
  });
  await modal.present();
  const result = await modal.onWillDismiss<{ action: WalletDemoAction }>();
  return ['confirm', 'cancel'].includes(result.data?.action ?? '') ? result.data!.action : null;
}
