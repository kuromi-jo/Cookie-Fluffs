/**
 * @file admin-menu.component.ts
 * @description Side menu for the superadmin dashboard: jump between dashboard sections, open the
 * customer app as shoppers see it ("View the shop"), account settings, and log out.
 */
import { Component, inject } from '@angular/core';
import { AlertController, IonContent, IonFooter, IonIcon, IonItem, IonLabel, IonList, IonListHeader, MenuController, NavController } from '@ionic/angular';
import { AuthService } from '../core/auth.service';
import { AdminService, AdminTab, setAdminShopView } from '../core/admin.service';

interface SectionLink {
  tab: AdminTab;
  title: string;
  icon: string;
  /** Read after the badge number by screen readers, e.g. "3 need action". */
  hint: string;
}

@Component({
  selector: 'app-admin-menu',
  imports: [IonContent, IonFooter, IonList, IonListHeader, IonItem, IonIcon, IonLabel],
  template: `
    <ion-content>
      <section class="head">
        <img src="assets/brand/cookie-logo.svg" alt="" aria-hidden="true" />
        <h2>{{ auth.user()?.fullName || 'Shop Admin' }}</h2>
        <p>{{ auth.user()?.email }}</p>
        <span class="role">Shop owner</span>
      </section>

      <ion-list lines="none" class="list">
        <ion-list-header>Dashboard</ion-list-header>
        @for (s of sections; track s.tab) {
          <ion-item button detail="false" [class.active]="admin.tab() === s.tab" (click)="go(s.tab)">
            <ion-icon slot="start" [name]="s.icon" aria-hidden="true"></ion-icon>
            <ion-label>{{ s.title }}</ion-label>
            @if (admin.badges()[s.tab]; as n) {
              <span class="count" slot="end" [attr.aria-label]="n + ' ' + s.hint">{{ n > 99 ? '99+' : n }}</span>
            }
          </ion-item>
        }

        <ion-list-header>Shop</ion-list-header>
        <ion-item button detail="false" (click)="viewShop()">
          <ion-icon slot="start" name="storefront-outline" aria-hidden="true"></ion-icon>
          <ion-label>View the shop<small>See the app as customers do</small></ion-label>
        </ion-item>

        <ion-list-header>Settings</ion-list-header>
        <ion-item button detail="false" (click)="open('/profile/settings')">
          <ion-icon slot="start" name="settings-outline" aria-hidden="true"></ion-icon>
          <ion-label>App settings</ion-label>
        </ion-item>
        <ion-item button detail="false" (click)="open('/profile/security')">
          <ion-icon slot="start" name="lock-closed-outline" aria-hidden="true"></ion-icon>
          <ion-label>Privacy and security</ion-label>
        </ion-item>
        <ion-item button detail="false" (click)="open('/help')">
          <ion-icon slot="start" name="help-circle-outline" aria-hidden="true"></ion-icon>
          <ion-label>Help and support</ion-label>
        </ion-item>
      </ion-list>
    </ion-content>
    <ion-footer class="foot">
      <button type="button" class="logout" (click)="logout()"><ion-icon name="log-out-outline" aria-hidden="true"></ion-icon>Log out</button>
    </ion-footer>
  `,
  styles: `
    :host { display: contents; }
    ion-content { --background: var(--cf-canvas); }
    .head { display: grid; justify-items: center; gap: 2px; padding: 28px 20px 18px; text-align: center; background: var(--cf-pink-soft); border-bottom: 1px solid var(--cf-pink-border); }
    .head img { width: 56px; height: 56px; margin-bottom: 6px; }
    .head h2 { margin: 0; font-family: var(--cf-font-display); font-size: 1.15rem; color: var(--cf-choco); }
    .head p { margin: 0; font-size: .8rem; color: var(--cf-choco-medium); overflow-wrap: anywhere; }
    .role { margin-top: 6px; padding: 3px 10px; border-radius: 999px; background: var(--cf-choco-btn); color: #fff; font-size: .68rem; font-weight: 800; }
    .list { padding: 6px 10px; background: transparent; }
    ion-list-header { min-height: 36px; padding-left: 10px; font-size: .72rem; font-weight: 800; letter-spacing: .06em; text-transform: uppercase; color: var(--cf-choco-light); }
    ion-item { --background: transparent; --border-radius: 12px; --min-height: 48px; --color: var(--cf-choco); margin-bottom: 2px; font-weight: 700; }
    ion-item.active { --background: var(--cf-pink-card); --color: var(--cf-pink-deep); }
    ion-item ion-icon { color: inherit; margin-inline-end: 14px; }
    .count { min-width: 22px; height: 22px; padding: 0 7px; box-sizing: border-box; border-radius: 999px; background: var(--cf-pink-deep); color: #fff; font-size: .72rem; font-weight: 800; line-height: 22px; text-align: center; }
    ion-label small { display: block; font-size: .72rem; font-weight: 600; color: var(--cf-choco-light); }
    .foot { padding: 10px 16px 16px; background: var(--cf-canvas); }
    .logout { display: flex; align-items: center; justify-content: center; gap: 8px; width: 100%; min-height: 48px; border: 1.5px solid var(--cf-pink-border); border-radius: 999px; background: #fff; color: var(--cf-choco); font: inherit; font-weight: 800; cursor: pointer; }
    .logout:focus-visible { outline: none; box-shadow: 0 0 0 3px var(--cf-pink-accent); }
  `,
})
export class AdminMenuComponent {
  readonly auth = inject(AuthService);
  readonly admin = inject(AdminService);
  private menu = inject(MenuController);
  private nav = inject(NavController);
  private alerts = inject(AlertController);

  readonly sections: SectionLink[] = [
    { tab: 'overview', title: 'Overview', icon: 'stats-chart-outline', hint: 'unread notifications' },
    { tab: 'orders', title: 'Orders', icon: 'receipt-outline', hint: 'new' },
    { tab: 'products', title: 'Products', icon: 'cf-cookie', hint: 'new' },
    { tab: 'reviews', title: 'Customer reviews', icon: 'star-outline', hint: 'new' },
    { tab: 'messages', title: 'Contact Us messages', icon: 'mail-outline', hint: 'new' },
  ];

  async go(tab: AdminTab): Promise<void> {
    this.admin.tab.set(tab);
    await this.menu.close('admin');
  }

  /** Opens the customer app; the shop's side menu then offers "Back to admin dashboard". */
  async viewShop(): Promise<void> {
    setAdminShopView(true);
    await this.menu.close('admin');
    await this.nav.navigateRoot('/home');
  }

  async open(url: string): Promise<void> {
    await this.menu.close('admin');
    await this.nav.navigateForward(url);
  }

  async logout(): Promise<void> {
    const alert = await this.alerts.create({
      header: 'Log out?',
      message: 'You can log back in to the dashboard any time.',
      cssClass: 'cf-alert-confirm',
      buttons: [
        { text: 'Stay logged in', role: 'cancel', cssClass: 'alert-btn-primary' },
        {
          text: 'Log out',
          role: 'destructive',
          cssClass: 'alert-btn-quiet',
          handler: () => {
            void this.menu.close('admin').then(() => {
              setAdminShopView(false);
              this.auth.logout();
              return this.nav.navigateRoot('/login');
            });
          },
        },
      ],
    });
    await alert.present();
  }
}
