/**
 * @file help.page.ts
 * @description Help center linking customers to implemented support and policy resources.
 */
import { Component } from '@angular/core';
import { RouterLink } from '@angular/router';
import { IonBackButton, IonButtons, IonContent, IonHeader, IonIcon, IonTitle, IonToolbar } from '@ionic/angular';

@Component({
  selector: 'app-help',
  templateUrl: 'help.page.html',
  styleUrls: ['../info-page.scss', 'help.page.scss'],
  imports: [RouterLink, IonHeader, IonToolbar, IonButtons, IonBackButton, IonTitle, IonContent, IonIcon],
})
export class HelpPage {}
