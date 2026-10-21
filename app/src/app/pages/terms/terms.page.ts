/**
 * @file terms.page.ts
 * @description Plain-language draft terms for the Cookie Fluffs class project.
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
import { TermsContentComponent } from '../../components/terms-content.component';

@Component({
  selector: 'app-terms',
  templateUrl: 'terms.page.html',
  styleUrls: ['../info-page.scss'],
  imports: [IonHeader, IonToolbar, IonButtons, IonBackButton, IonTitle, IonContent, TermsContentComponent],
})
export class TermsPage {}
