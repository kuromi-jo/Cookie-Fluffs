/**
 * @file addresses.page.ts
 * @description Authenticated saved-address list, default selection, and deletion.
 */
import { BackNavService } from '../../core/back-nav.service';
import { Component, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import {
  AlertController,
  IonBackButton,
  IonButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonIcon,
  IonSpinner,
  IonTitle,
  IonToolbar,
} from '@ionic/angular';
import { AddressService } from '../../core/address.service';
import { apiErrorMessage } from '../../core/api-error';
import { AuthService } from '../../core/auth.service';
import { SavedAddress } from '../../core/models';
import { UiService } from '../../core/ui.service';

@Component({
  selector: 'app-addresses',
  templateUrl: 'addresses.page.html',
  styleUrls: ['addresses.page.scss'],
  imports: [RouterLink, IonHeader, IonToolbar, IonButtons, IonBackButton, IonTitle, IonContent, IonButton, IonIcon, IonSpinner],
})
export class AddressesPage {
  /** Back goes to wherever this page was opened from (Profile by default). */
  readonly backHref = inject(BackNavService).backHref('/profile', '/profile/addresses');
  readonly addressBook = inject(AddressService);
  private auth = inject(AuthService);
  private router = inject(Router);
  private alerts = inject(AlertController);
  private ui = inject(UiService);

  readonly loading = signal(true);
  readonly error = signal('');
  readonly changingId = signal('');

  async ionViewWillEnter(): Promise<void> {
    if (!this.auth.isLoggedIn()) {
      await this.router.navigate(['/login'], { queryParams: { returnUrl: '/profile/addresses' }, replaceUrl: true });
      return;
    }
    await this.load();
  }

  async load(): Promise<void> {
    this.loading.set(true);
    this.error.set('');
    try {
      await this.addressBook.load();
    } catch (error) {
      this.error.set(apiErrorMessage(error));
    } finally {
      this.loading.set(false);
    }
  }

  async makeDefault(address: SavedAddress): Promise<void> {
    if (address.isDefault || this.changingId()) return;
    this.changingId.set(address.id);
    this.error.set('');
    try {
      await this.addressBook.setDefault(address.id);
      await this.ui.toast(`${address.label} is now your default address.`, { icon: 'checkmark-circle' });
    } catch (error) {
      this.error.set(apiErrorMessage(error));
    } finally {
      this.changingId.set('');
    }
  }

  async confirmDelete(address: SavedAddress): Promise<void> {
    const alert = await this.alerts.create({
      header: `Keep ${address.label}?`,
      message: 'Deleting this saved address will not change your existing orders.',
      cssClass: 'cf-alert-confirm',
      buttons: [
        { text: 'Keep address', role: 'cancel' },
        { text: 'Delete address', role: 'destructive', handler: () => void this.remove(address) },
      ],
    });
    await alert.present();
  }

  private async remove(address: SavedAddress): Promise<void> {
    if (this.changingId()) return;
    this.changingId.set(address.id);
    this.error.set('');
    try {
      await this.addressBook.delete(address.id);
      await this.ui.toast('Saved address deleted.', { icon: 'trash-outline' });
    } catch (error) {
      this.error.set(apiErrorMessage(error));
    } finally {
      this.changingId.set('');
    }
  }
}
