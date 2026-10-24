/**
 * @file faq.page.ts
 * @description Accurate answers about currently implemented Cookie Fluffs features.
 */
import { Component } from '@angular/core';
import { RouterLink } from '@angular/router';
import { IonBackButton, IonButton, IonButtons, IonContent, IonHeader, IonTitle, IonToolbar } from '@ionic/angular';

@Component({
  selector: 'app-faq',
  templateUrl: 'faq.page.html',
  styleUrls: ['../info-page.scss', 'faq.page.scss'],
  imports: [RouterLink, IonHeader, IonToolbar, IonButtons, IonBackButton, IonTitle, IonContent, IonButton],
})
export class FaqPage {}
