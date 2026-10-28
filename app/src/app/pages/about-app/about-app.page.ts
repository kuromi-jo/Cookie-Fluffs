/**
 * @file about-app.page.ts
 * @description App information, tech stack and everything completed in this build.
 */
import { Component, inject } from '@angular/core';
import {
  IonButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonIcon,
  IonMenuButton,
  IonTitle,
  IonToolbar,
  NavController,
} from '@ionic/angular';
import { BackNavService } from '../../core/back-nav.service';

@Component({
  selector: 'app-about-app',
  templateUrl: 'about-app.page.html',
  styleUrls: ['../info-page.scss', 'about-app.page.scss'],
  imports: [IonButton, IonHeader, IonToolbar, IonButtons, IonMenuButton, IonTitle, IonContent, IonIcon],
})
export class AboutAppPage {
  private nav = inject(NavController);
  /** The page this was opened from (e.g. Help); empty on a fresh load, where only the menu button shows. */
  readonly backHref = inject(BackNavService).backHref('', '/about-app');

  goBack(): void {
    void this.nav.navigateBack(this.backHref);
  }

  readonly version = '1.0.0';

  readonly stack = [
    { icon: 'logo-ionic', name: 'Ionic Framework 9', role: 'Mobile UI components' },
    { icon: 'logo-angular', name: 'Angular 22', role: 'App framework (standalone + signals)' },
    { icon: 'server-outline', name: 'Node.js + Express', role: 'REST API' },
    { icon: 'cloud-done-outline', name: 'Neon PostgreSQL', role: 'Cloud database' },
  ];

  readonly ready = [
    'Splash screen & app icon',
    'Live product menu from the database, with search, categories, sorting and roulette',
    'Product pages with pack choice and customer reviews',
    'Mix-and-match cookie box builder',
    'Sign up / Log in with profile photo, plus Continue with Google',
    'Shopping cart saved to your account',
    'Checkout with cash, GCash and Maya, plus vouchers',
    'Live order tracking with a map and order history',
    'Instant notifications for order and payment updates',
    'Ratings and reviews, with an anonymous option',
    'Account security: email verification codes for password and contact changes',
    'Admin dashboard: sales, orders, products, reviews and messages',
    'Contact form',
  ];
}
