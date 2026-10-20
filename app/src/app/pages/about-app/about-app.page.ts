/**
 * @file about-app.page.ts
 * @description App information, tech stack and what is coming next.
 */
import { Component } from '@angular/core';
import {
  IonButtons,
  IonContent,
  IonHeader,
  IonIcon,
  IonMenuButton,
  IonTitle,
  IonToolbar,
} from '@ionic/angular';

@Component({
  selector: 'app-about-app',
  templateUrl: 'about-app.page.html',
  styleUrls: ['../info-page.scss', 'about-app.page.scss'],
  imports: [IonHeader, IonToolbar, IonButtons, IonMenuButton, IonTitle, IonContent, IonIcon],
})
export class AboutAppPage {
  readonly version = '0.6.0';

  readonly stack = [
    { icon: 'logo-ionic', name: 'Ionic Framework 9', role: 'Mobile UI components' },
    { icon: 'logo-angular', name: 'Angular 22', role: 'App framework (standalone + signals)' },
    { icon: 'server-outline', name: 'Node.js + Express', role: 'REST API' },
    { icon: 'cloud-done-outline', name: 'Neon PostgreSQL', role: 'Cloud database' },
  ];

  readonly ready = [
    'Splash screen & app icon',
    'Live product menu from the database',
    'Search & category filters',
    'Product detail pages',
    'Sign up / Log in with profile photo',
    'Shopping cart saved to your account',
    'Contact form',
  ];

  readonly next = [
    'Cookie Builder: dough → mix-ins → toppings',
    'Checkout with GCash, Maya, card & COD',
    'Order tracking & history',
    'Community gallery & leaderboard',
    'Fluff Points loyalty rewards',
    'Admin panel & sales dashboard',
  ];
}
