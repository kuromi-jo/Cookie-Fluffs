/**
 * @file profile.page.ts
 * @description Authenticated customer profile and editable personal information.
 */
import { Component, inject, signal } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import {
  AlertController,
  IonButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonIcon,
  IonInput,
  IonMenuButton,
  IonSpinner,
  IonTitle,
  IonToolbar,
} from '@ionic/angular';
import { AvatarComponent } from '../../components/avatar.component';
import { apiErrorMessage, apiFieldErrors } from '../../core/api-error';
import { AuthService } from '../../core/auth.service';
import { fileToAvatar } from '../../core/image';
import { User } from '../../core/models';
import { validateFirstName, validateLastName, validatePhone } from '../../core/signup-rules';
import { UiService } from '../../core/ui.service';

type ProfileField = 'firstName' | 'lastName' | 'phone';
type ProfileErrors = Partial<Record<ProfileField, string>>;

export interface ProfileDraft {
  firstName: string;
  lastName: string;
  phone: string;
  avatar: string | null;
}

export function profileDraft(user: User): ProfileDraft {
  return {
    firstName: user.firstName ?? user.fullName.split(' ')[0] ?? '',
    lastName: user.lastName ?? user.fullName.split(' ').slice(1).join(' '),
    phone: user.phone,
    avatar: user.avatar,
  };
}

export function validateProfile(draft: ProfileDraft): ProfileErrors {
  const errors: ProfileErrors = {};
  const firstName = validateFirstName(draft.firstName);
  const lastName = validateLastName(draft.lastName);
  const phone = validatePhone(draft.phone);
  if (firstName) errors.firstName = firstName;
  if (lastName) errors.lastName = lastName;
  if (phone) errors.phone = phone;
  return errors;
}

@Component({
  selector: 'app-profile',
  templateUrl: 'profile.page.html',
  styleUrls: ['profile.page.scss'],
  imports: [
    FormsModule,
    RouterLink,
    AvatarComponent,
    IonHeader,
    IonToolbar,
    IonButtons,
    IonMenuButton,
    IonTitle,
    IonContent,
    IonButton,
    IonIcon,
    IonInput,
    IonSpinner,
  ],
})
export class ProfilePage {
  readonly auth = inject(AuthService);
  private router = inject(Router);
  private alerts = inject(AlertController);
  private ui = inject(UiService);

  readonly loading = signal(true);
  readonly loadError = signal('');
  readonly editing = signal(false);
  readonly saving = signal(false);
  readonly pageError = signal('');
  readonly errors = signal<ProfileErrors>({});
  readonly touched = signal<ReadonlySet<ProfileField>>(new Set());
  readonly draft = signal<ProfileDraft>({ firstName: '', lastName: '', phone: '', avatar: null });
  private avatarChanged = false;

  async ionViewWillEnter(): Promise<void> {
    if (!this.auth.isLoggedIn()) {
      await this.router.navigate(['/login'], { queryParams: { returnUrl: '/profile' }, replaceUrl: true });
      return;
    }
    await this.loadProfile();
  }

  async loadProfile(): Promise<void> {
    this.loading.set(true);
    this.loadError.set('');
    try {
      await this.auth.refreshProfile();
      this.resetDraft();
    } catch (error) {
      if (error instanceof HttpErrorResponse && error.status === 401) {
        this.auth.logout();
        await this.router.navigate(['/login'], { queryParams: { returnUrl: '/profile' }, replaceUrl: true });
        return;
      }
      this.loadError.set(apiErrorMessage(error));
    } finally {
      this.loading.set(false);
    }
  }

  startEditing(): void {
    this.resetDraft();
    this.editing.set(true);
  }

  cancelEditing(): void {
    this.resetDraft();
    this.editing.set(false);
  }

  update(field: ProfileField, value: string | null | undefined): void {
    this.draft.update((current) => ({ ...current, [field]: value ?? '' }));
    this.pageError.set('');
    if (this.touched().has(field) || this.errors()[field]) this.validateField(field);
  }

  blur(field: ProfileField): void {
    this.touched.update((current) => new Set(current).add(field));
    this.validateField(field);
  }

  fieldError(field: ProfileField): string | undefined {
    return this.errors()[field];
  }

  isTouched(field: ProfileField): boolean {
    return this.touched().has(field);
  }

  async onPhotoPicked(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    try {
      const avatar = await fileToAvatar(file);
      this.draft.update((current) => ({ ...current, avatar }));
      this.avatarChanged = true;
      this.pageError.set('');
    } catch (error) {
      this.pageError.set(error instanceof Error ? error.message : 'Could not read that image.');
    }
  }

  async save(): Promise<void> {
    if (this.saving()) return;
    const errors = validateProfile(this.draft());
    this.touched.set(new Set<ProfileField>(['firstName', 'lastName', 'phone']));
    this.errors.set(errors);
    if (Object.keys(errors).length) {
      await this.focusFirstError(errors);
      return;
    }

    this.saving.set(true);
    this.pageError.set('');
    const draft = this.draft();
    try {
      await this.auth.updateProfile({
        firstName: draft.firstName.trim(),
        lastName: draft.lastName.trim(),
        phone: draft.phone,
        ...(this.avatarChanged ? { avatar: draft.avatar } : {}),
      });
      this.resetDraft();
      this.editing.set(false);
      await this.ui.toast('Personal information updated.', { icon: 'checkmark-circle' });
    } catch (error) {
      const fieldErrors = apiFieldErrors(error) as ProfileErrors;
      this.errors.update((current) => ({ ...current, ...fieldErrors }));
      this.pageError.set(apiErrorMessage(error));
      if (Object.keys(fieldErrors).length) await this.focusFirstError(fieldErrors);
    } finally {
      this.saving.set(false);
    }
  }

  async confirmLogout(): Promise<void> {
    const alert = await this.alerts.create({
      header: 'Log out?',
      message: 'Your cart stays saved for the next time you log in.',
      buttons: [
        { text: 'Stay', role: 'cancel' },
        {
          text: 'Log out',
          role: 'destructive',
          handler: () => {
            this.auth.logout();
            void this.router.navigateByUrl('/home');
            void this.ui.toast('You have been logged out. See you soon!', { icon: 'log-out-outline' });
          },
        },
      ],
      cssClass: 'cf-alert-confirm',
    });
    await alert.present();
  }

  private resetDraft(): void {
    const user = this.auth.user();
    if (user) this.draft.set(profileDraft(user));
    this.errors.set({});
    this.touched.set(new Set());
    this.pageError.set('');
    this.avatarChanged = false;
  }

  private validateField(field: ProfileField): void {
    const message = validateProfile(this.draft())[field];
    this.errors.update((current) => ({ ...current, [field]: message }));
  }

  private async focusFirstError(errors: ProfileErrors): Promise<void> {
    const field = (['firstName', 'lastName', 'phone'] as ProfileField[]).find((candidate) => errors[candidate]);
    if (!field) return;
    await new Promise((resolve) => setTimeout(resolve));
    const input = document.getElementById(`profile-${field}`) as (HTMLElement & { setFocus?: () => Promise<void> }) | null;
    input?.scrollIntoView({ behavior: 'auto', block: 'center' });
    await input?.setFocus?.();
  }
}
