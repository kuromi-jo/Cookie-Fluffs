/**
 * @file developers.page.ts
 * @description The team behind Cookie Fluffs.
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
import { AvatarComponent } from '../../components/avatar.component';

interface Developer {
  name: string;
  photo: string;
  role: string;
  focus: string[];
  leader?: boolean;
}

@Component({
  selector: 'app-developers',
  templateUrl: 'developers.page.html',
  styleUrls: ['../info-page.scss', 'developers.page.scss'],
  imports: [IonHeader, IonToolbar, IonButtons, IonMenuButton, IonTitle, IonContent, IonIcon, AvatarComponent],
})
export class DevelopersPage {
  readonly team: Developer[] = [
    { name: 'Jonie D. Aguihap', photo: 'assets/team/aguihap.webp', role: 'Project Leader & System Architect', focus: ['Planning', 'Architecture'], leader: true },
    { name: 'Jervin Paul Romualdo', photo: 'assets/team/romualdo.webp', role: 'Mobile UI/UX & Ionic Specialist', focus: ['Ionic', 'UI Design'] },
    { name: 'Bianca Galvez', photo: 'assets/team/galvez.webp', role: 'Frontend & Cookie Builder Engineer', focus: ['Angular', 'Frontend'] },
    { name: 'Rhangel Mansilla', photo: 'assets/team/mansilla.webp', role: 'QA Testing & Database Architect', focus: ['Neon DB', 'Testing'] },
    { name: 'Luigi Ray Natal', photo: 'assets/team/natal.webp', role: 'Backend Integration & Payments Lead', focus: ['Express API', 'Integration'] },
    { name: 'Aldred Rapacon', photo: 'assets/team/rapacon.webp', role: 'Product Strategy & Content Operations', focus: ['Content', 'Strategy'] },
  ];
}
