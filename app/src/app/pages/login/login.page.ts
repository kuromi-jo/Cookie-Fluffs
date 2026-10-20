/**
 * @file login.page.ts
 * @description Log in / Sign up. Accounts are stored in Neon (passwords are hashed on the server).
 */
import { Component, inject, input, signal } from '@angular/core';
import { FormsModule, NgForm } from '@angular/forms';
import { Router } from '@angular/router';
import { HttpErrorResponse } from '@angular/common/http';
import {
  IonBackButton,
  IonButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonIcon,
  IonInput,
  IonInputPasswordToggle,
  IonSegment,
  IonSegmentButton,
  IonLabel,
  IonSpinner,
  IonToolbar,
  NavController,
} from '@ionic/angular';
import { AuthService } from '../../core/auth.service';
import { UiService } from '../../core/ui.service';
import { apiErrorMessage } from '../../core/api-error';
import { fileToAvatar } from '../../core/image';
import { AvatarComponent } from '../../components/avatar.component';

type Mode = 'login' | 'signup';

@Component({
  selector: 'app-login',
  templateUrl: 'login.page.html',
  styleUrls: ['login.page.scss'],
  imports: [
    FormsModule,
    IonHeader,
    IonToolbar,
    IonButtons,
    IonBackButton,
    IonContent,
    IonSegment,
    IonSegmentButton,
    IonLabel,
    IonInput,
    IonInputPasswordToggle,
    IonButton,
    IonIcon,
    IonSpinner,
    AvatarComponent,
  ],
})
export class LoginPage {
  /** Where to go after logging in (query param ?returnUrl=/cart). */
  readonly returnUrl = input<string>();

  private auth = inject(AuthService);
  private ui = inject(UiService);
  private nav = inject(NavController);
  private router = inject(Router);

  readonly mode = signal<Mode>('login');
  readonly submitting = signal(false);
  readonly error = signal<string | null>(null);
  readonly avatar = signal<string | null>(null);

  // Form fields
  email = '';
  password = '';
  fullName = '';
  phone = '';

  setMode(value: unknown): void {
    if (value === 'login' || value === 'signup') {
      this.mode.set(value);
      this.error.set(null);
    }
  }

  async pickPhoto(event: Event): Promise<void> {
    const inputEl = event.target as HTMLInputElement;
    const file = inputEl.files?.[0];
    inputEl.value = '';
    if (!file) return;
    try {
      this.avatar.set(await fileToAvatar(file));
    } catch (err) {
      await this.ui.toast(err instanceof Error ? err.message : 'Could not use that photo.', { error: true });
    }
  }

  async submit(form: NgForm): Promise<void> {
    this.error.set(null);
    if (form.invalid) {
      form.control.markAllAsTouched();
      this.error.set('Please fill in all the required fields.');
      return;
    }

    this.submitting.set(true);
    try {
      const user =
        this.mode() === 'login'
          ? await this.auth.login(this.email, this.password)
          : await this.auth.signup({
              fullName: this.fullName,
              email: this.email,
              phone: this.phone,
              password: this.password,
              avatar: this.avatar(),
            });

      const first = user.fullName.split(' ')[0];
      const welcome = this.mode() === 'login' ? `Welcome back, ${first}!` : `Welcome to Cookie Fluffs, ${first}!`;
      this.password = '';
      const target = this.returnUrl();
      // Navigate first; the welcome toast is a nice-to-have and must never hold up the redirect.
      await this.nav.navigateRoot(target && target.startsWith('/') && target !== '/login' ? target : '/home');
      void this.ui.toast(welcome, { icon: 'heart' });
    } catch (err) {
      this.error.set(
        err instanceof HttpErrorResponse || !(err instanceof Error) ? apiErrorMessage(err) : err.message,
      );
    } finally {
      this.submitting.set(false);
    }
  }

  browseAsGuest(): void {
    void this.router.navigateByUrl('/home');
  }
}
