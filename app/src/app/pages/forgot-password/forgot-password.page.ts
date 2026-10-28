/**
 * @file forgot-password.page.ts
 * @description Forgot-password step 1: request a 6-digit code by email (enumeration-safe), then
 * continue to the code screen. The email travels in navigation state, never in the URL.
 */
import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import {
  IonBackButton, IonButton, IonButtons, IonContent, IonHeader, IonIcon, IonInput,
  IonSpinner, IonTitle, IonToolbar,
} from '@ionic/angular';
import { apiErrorMessage } from '../../core/api-error';
import { AuthService } from '../../core/auth.service';
import { validateEmail } from '../../core/signup-rules';

@Component({
  selector: 'app-forgot-password',
  templateUrl: 'forgot-password.page.html',
  styleUrls: ['forgot-password.page.scss'],
  imports: [
    FormsModule, RouterLink, IonHeader, IonToolbar, IonButtons, IonBackButton, IonTitle,
    IonContent, IonInput, IonIcon, IonButton, IonSpinner,
  ],
})
export class ForgotPasswordPage {
  private auth = inject(AuthService);
  private router = inject(Router);

  readonly loading = signal(true);
  readonly available = signal(false);
  readonly submitting = signal(false);
  readonly error = signal('');
  readonly emailError = signal('');
  email = '';

  async ionViewWillEnter(): Promise<void> {
    this.loading.set(true);
    this.error.set('');
    try {
      this.available.set((await this.auth.passwordRecoveryConfig()).enabled);
    } catch {
      this.available.set(false);
    } finally {
      this.loading.set(false);
    }
  }

  updateEmail(value: string | null | undefined): void {
    this.email = value ?? '';
    this.error.set('');
    if (this.emailError()) this.validate();
  }

  validate(): boolean {
    const message = validateEmail(this.email) ?? '';
    this.emailError.set(message);
    return !message;
  }

  async submit(): Promise<void> {
    if (this.submitting() || !this.available() || !this.validate()) return;
    this.submitting.set(true);
    this.error.set('');
    try {
      const email = this.email.trim();
      await this.auth.requestPasswordReset(email);
      await this.router.navigate(['/reset-password'], { state: { email } });
    } catch (error) {
      this.error.set(apiErrorMessage(error));
    } finally {
      this.submitting.set(false);
    }
  }
}
