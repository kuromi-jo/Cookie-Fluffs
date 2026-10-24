/**
 * @file simulated-card-verification.modal.ts
 * @description Accessible in-app authentication choice for the synthetic 3DS card flow.
 */
import { Component, HostListener, inject } from '@angular/core';
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

@Component({
  selector: 'app-simulated-card-verification',
  imports: [IonHeader, IonToolbar, IonTitle, IonButtons, IonButton, IonIcon, IonContent, IonFooter],
  template: `
    <ion-header class="cf-header">
      <ion-toolbar>
        <ion-title class="cf-title">Test verification</ion-title>
        <ion-buttons slot="end">
          <ion-button class="close" fill="clear" aria-label="Close test verification" (click)="cancel()">
            <ion-icon slot="icon-only" name="close" aria-hidden="true"></ion-icon>
          </ion-button>
        </ion-buttons>
      </ion-toolbar>
    </ion-header>

    <ion-content>
      <div class="verification-body">
        <span class="verification-mark"><ion-icon name="lock-closed-outline" aria-hidden="true"></ion-icon></span>
        <h2>Simulated card verification</h2>
        <p>This step only demonstrates how card authentication can work. No bank is contacted, and no OTP or account credentials are needed.</p>
        <div class="simulation-note" role="note">
          <ion-icon name="information-circle-outline" aria-hidden="true"></ion-icon>
          <span>Choose a test result to continue with this class-project order.</span>
        </div>
      </div>
    </ion-content>

    <ion-footer>
      <div class="verification-actions">
        <ion-button class="cf-btn-lg" expand="block" (click)="finish(true)">Approve test verification</ion-button>
        <ion-button fill="outline" expand="block" (click)="finish(false)">Fail test verification</ion-button>
      </div>
    </ion-footer>
  `,
  styles: `
    :host { display: flex; flex-direction: column; height: 100%; background: var(--cf-canvas); }
    ion-content { --background: var(--cf-canvas); }
    ion-footer { background: #fff; box-shadow: none; }
    .close { width: 44px; height: 44px; --padding-start: 0; --padding-end: 0; }
    .verification-body { display: grid; justify-items: center; padding: 32px 20px 24px; text-align: center; }
    .verification-mark { display: grid; place-items: center; width: 64px; height: 64px; margin-bottom: 18px; border: 1px solid var(--cf-pink-border); border-radius: 50%; background: var(--cf-pink-soft); color: var(--cf-pink-deep); font-size: 28px; }
    h2 { margin: 0 0 10px; font-family: var(--cf-font-display); font-size: 1.55rem; color: var(--cf-choco); }
    p { max-width: 320px; margin: 0; color: var(--cf-choco-medium); font-size: .82rem; line-height: 1.55; }
    .simulation-note { display: flex; align-items: flex-start; gap: 8px; max-width: 320px; margin-top: 22px; padding: 13px 14px; border: 1px solid var(--cf-pink-border); border-radius: var(--cf-radius-sm); background: #fff; color: var(--cf-choco-light); font-size: .74rem; line-height: 1.45; text-align: left; }
    .simulation-note ion-icon { flex: none; margin-top: 2px; color: var(--cf-pink-deep); }
    .verification-actions { display: grid; gap: 8px; padding: 12px 20px calc(14px + var(--ion-safe-area-bottom)); border-top: 1px solid var(--cf-pink-border); }
    .verification-actions ion-button { min-height: 44px; margin: 0; }
    @media (prefers-reduced-motion: reduce) { :host { scroll-behavior: auto; } }
  `,
})
export class SimulatedCardVerificationModalComponent {
  private readonly modal = inject(ModalController);
  private closing = false;

  @HostListener('document:keydown.escape', ['$event'])
  closeOnEscape(event: Event): void {
    event.preventDefault();
    event.stopPropagation();
    this.cancel();
  }

  finish(approved: boolean): void {
    if (this.closing) return;
    this.closing = true;
    void this.modal.dismiss({ approved }, 'confirm');
  }

  cancel(): void {
    if (this.closing) return;
    this.closing = true;
    void this.modal.dismiss(null, 'cancel');
  }
}

export async function presentSimulatedCardVerification(modals: ModalController): Promise<boolean | null> {
  const modal = await modals.create({
    component: SimulatedCardVerificationModalComponent,
    cssClass: 'cf-sheet',
    initialBreakpoint: 0.72,
    breakpoints: [0, 0.72, 1],
    backdropDismiss: true,
  });
  await modal.present();
  const result = await modal.onWillDismiss<{ approved: boolean }>();
  return result.role === 'confirm' && typeof result.data?.approved === 'boolean' ? result.data.approved : null;
}
