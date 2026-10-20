/**
 * @file ui.service.ts
 * @description Branded toasts. They appear at the bottom (sitting above any footer bar)
 * so they never cover the menu or cart buttons in the header.
 */
import { Injectable, inject } from '@angular/core';
import { ToastButton, ToastController } from '@ionic/angular';

export interface ToastOpts {
  icon?: string;
  error?: boolean;
  duration?: number;
  buttons?: ToastButton[];
}

@Injectable({ providedIn: 'root' })
export class UiService {
  private toasts = inject(ToastController);

  async toast(message: string, opts: ToastOpts = {}): Promise<void> {
    await this.toasts.getTop().then((t) => t?.dismiss());
    const toast = await this.toasts.create({
      message,
      icon: opts.icon ?? (opts.error ? 'alert-circle' : 'checkmark-circle'),
      duration: opts.duration ?? 2200,
      position: 'bottom',
      positionAnchor: activeFooter(),
      cssClass: opts.error ? ['cf-toast', 'cf-toast-error'] : 'cf-toast',
      buttons: opts.buttons ?? [{ icon: 'close', role: 'cancel' }],
    });
    await toast.present();
  }
}

/** The footer bar of the page currently on screen, if it has one. */
function activeFooter(): HTMLElement | undefined {
  const pages = document.querySelectorAll('ion-router-outlet > .ion-page:not(.ion-page-hidden)');
  const page = pages[pages.length - 1];
  return (page?.querySelector(':scope > ion-footer') as HTMLElement | null) ?? undefined;
}
