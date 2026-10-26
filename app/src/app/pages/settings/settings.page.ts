/**
 * @file settings.page.ts
 * @description Customer accessibility settings backed by PostgreSQL.
 */
import { Component, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import {
  IonBackButton,
  IonButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonIcon,
  IonSpinner,
  IonTitle,
  IonToggle,
  IonToolbar,
} from '@ionic/angular';
import { AuthService } from '../../core/auth.service';
import { PreferenceService } from '../../core/preference.service';
import { UiService } from '../../core/ui.service';

@Component({
  selector: 'app-settings',
  templateUrl: 'settings.page.html',
  styleUrls: ['settings.page.scss'],
  imports: [IonHeader, IonToolbar, IonButtons, IonBackButton, IonTitle, IonContent, IonIcon, IonToggle, IonButton, IonSpinner],
})
export class SettingsPage {
  readonly preferences = inject(PreferenceService);
  private auth = inject(AuthService);
  private router = inject(Router);
  private ui = inject(UiService);
  readonly reduceMotion = signal(false);
  readonly largerText = signal(false);
  readonly notifyOrderUpdates = signal(true);

  async ionViewWillEnter(): Promise<void> {
    if (!this.auth.isLoggedIn()) {
      await this.router.navigate(['/login'], { queryParams: { returnUrl: '/profile/settings' }, replaceUrl: true });
      return;
    }
    try {
      const values = await this.preferences.load();
      this.reduceMotion.set(values.reduceMotion);
      this.largerText.set(values.largerText);
      this.notifyOrderUpdates.set(values.notifyOrderUpdates ?? true);
    } catch {
      const current = this.preferences.preferences();
      this.reduceMotion.set(current.reduceMotion);
      this.largerText.set(current.largerText);
      this.notifyOrderUpdates.set(current.notifyOrderUpdates ?? true);
    }
  }

  async save(): Promise<void> {
    try {
      await this.preferences.save({
        reduceMotion: this.reduceMotion(),
        largerText: this.largerText(),
        notifyOrderUpdates: this.notifyOrderUpdates(),
      });
      await this.ui.toast('App settings saved.', { icon: 'checkmark-circle' });
    } catch {
      // The service exposes the accessible page error.
    }
  }
}
