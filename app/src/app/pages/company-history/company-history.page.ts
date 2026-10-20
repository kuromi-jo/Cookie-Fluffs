/**
 * @file company-history.page.ts
 * @description The Cookie Fluffs story.
 */
import { Component } from '@angular/core';
import { RouterLink } from '@angular/router';
import {
  IonButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonIcon,
  IonMenuButton,
  IonTitle,
  IonToolbar,
} from '@ionic/angular';

@Component({
  selector: 'app-company-history',
  templateUrl: 'company-history.page.html',
  styleUrls: ['../info-page.scss'],
  imports: [RouterLink, IonHeader, IonToolbar, IonButtons, IonMenuButton, IonTitle, IonContent, IonIcon, IonButton],
})
export class CompanyHistoryPage {
  readonly milestones = [
    {
      year: '2024',
      title: 'A dorm-room oven',
      text: 'It started with one tiny oven, a borrowed mixer and a craving for a cookie that was crispy outside and cloud-soft inside.',
    },
    {
      year: '2025',
      title: 'The first 100 boxes',
      text: 'Friends became regulars. Weekend pre-orders in Cubao sold out, and the bitten cookie with a white heart became our signature.',
    },
    {
      year: 'Early 2026',
      title: 'Filipino flavors join the menu',
      text: 'Ube halaya, Antipolo kasoy and nostalgic Chocnut found their way into our dough. Local flavors, baked our way.',
    },
    {
      year: 'Today',
      title: 'Cookie Fluffs goes mobile',
      text: 'Our own app lets you browse the full menu, build your cookie box and order fresh bakes in a few taps.',
    },
  ];

  readonly values = [
    { icon: 'cloud-outline', title: 'Fluffy by design', text: 'Thick, soft-centered cookies with golden, crisp edges.' },
    { icon: 'leaf-outline', title: 'Real ingredients', text: 'Real butter, Belgian chocolate and local produce. No shortcuts.' },
    { icon: 'heart-outline', title: 'Baked with heart', text: 'Small batches, baked fresh every morning.' },
  ];
}
