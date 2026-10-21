/**
 * @file privacy.page.ts
 * @description Plain-language draft privacy information for the Cookie Fluffs class project.
 */
import { Component } from '@angular/core';
import {
  IonBackButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonTitle,
  IonToolbar,
} from '@ionic/angular';
import { PrivacyContentComponent } from '../../components/privacy-content.component';

@Component({
  selector: 'app-privacy',
  templateUrl: 'privacy.page.html',
  styleUrls: ['../info-page.scss'],
  imports: [IonHeader, IonToolbar, IonButtons, IonBackButton, IonTitle, IonContent, PrivacyContentComponent],
})
export class PrivacyPage {}
