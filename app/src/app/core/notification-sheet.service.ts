/**
 * @file notification-sheet.service.ts
 * @description Opens the customer's notifications as a full-screen sheet that slides up over the
 * current page, so closing it (X) returns to the same page and scroll position.
 */
import { Injectable, inject } from '@angular/core';
import { Router } from '@angular/router';
import { ModalController } from '@ionic/angular';
import { AuthService } from './auth.service';

@Injectable({ providedIn: 'root' })
export class NotificationSheetService {
  private modals = inject(ModalController);
  private auth = inject(AuthService);
  private router = inject(Router);
  private opening = false;

  async open(): Promise<void> {
    if (!this.auth.isLoggedIn()) {
      await this.router.navigate(['/login'], { queryParams: { returnUrl: this.router.url.split('?')[0] } });
      return;
    }
    if (this.opening || (await this.modals.getTop())) return;
    this.opening = true;
    try {
      const { NotificationsPage } = await import('../pages/notifications/notifications.page');
      const sheet = await this.modals.create({
        component: NotificationsPage,
        componentProps: { asSheet: true },
        cssClass: 'cf-notif-sheet',
      });
      await sheet.present();
    } finally {
      this.opening = false;
    }
  }
}
