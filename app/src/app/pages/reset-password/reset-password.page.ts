/**
 * @file reset-password.page.ts
 * @description Forgot-password step 2: enter the 6-digit code from the email and choose a new password.
 * The email comes from step 1 through navigation state (never the URL) and can be edited.
 */
import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import {
  IonBackButton, IonButton, IonButtons, IonContent, IonHeader, IonIcon, IonInput,
  IonInputPasswordToggle, IonSpinner, IonTitle, IonToolbar,
} from '@ionic/angular';
import { apiErrorMessage, apiFieldErrors } from '../../core/api-error';
import { AuthService } from '../../core/auth.service';
import { validateConfirmPassword, validateEmail, validatePassword } from '../../core/signup-rules';
import { PasswordRequirementsComponent } from '../../components/password-requirements.component';

type ResetField = 'email' | 'code' | 'newPassword' | 'confirmPassword';
type ResetErrors = Partial<Record<ResetField, string>>;

/** Validates the emailed code: exactly six digits. */
export function validateResetCode(code: string): string | null {
  const digits = code.replace(/\s/g, '');
  if (!digits) return 'Enter the 6-digit code from your email.';
  return /^\d{6}$/.test(digits) ? null : 'The code is 6 digits, like 042917.';
}

@Component({
  selector: 'app-reset-password',
  templateUrl: 'reset-password.page.html',
  styleUrls: ['reset-password.page.scss'],
  imports: [
    FormsModule, RouterLink, IonHeader, IonToolbar, IonButtons, IonBackButton, IonTitle,
    IonContent, IonInput, IonInputPasswordToggle, IonIcon, IonButton, IonSpinner,
    PasswordRequirementsComponent,
  ],
})
export class ResetPasswordPage {
  private auth = inject(AuthService);

  readonly loading = signal(true);
  readonly available = signal(false);
  readonly submitting = signal(false);
  readonly succeeded = signal(false);
  readonly pageError = signal('');
  readonly errors = signal<ResetErrors>({});
  /** True when the email was carried over from "Forgot password" (shown as "sent to ..."). */
  readonly emailFromRequest = signal(false);
  email = '';
  code = '';
  newPassword = '';
  confirmPassword = '';

  async ionViewWillEnter(): Promise<void> {
    const carried = (globalThis.history?.state as { email?: unknown } | null)?.email;
    if (typeof carried === 'string' && carried && !this.email) {
      this.email = carried;
      this.emailFromRequest.set(true);
    }
    try {
      this.available.set((await this.auth.passwordRecoveryConfig()).enabled);
    } catch {
      this.available.set(false);
    } finally {
      this.loading.set(false);
    }
  }

  ionViewDidLeave(): void {
    if (this.succeeded()) this.reset();
  }

  update(field: ResetField, value: string | null | undefined): void {
    this[field] = value ?? '';
    this.pageError.set('');
    if (this.errors()[field]) this.validateField(field);
    if (field === 'newPassword' && this.errors().confirmPassword) this.validateField('confirmPassword');
  }

  validateField(field: ResetField): void {
    const message = this.messageFor(field);
    this.errors.update((current) => {
      const next = { ...current };
      if (message) next[field] = message;
      else delete next[field];
      return next;
    });
  }

  validate(): boolean {
    const errors: ResetErrors = {};
    for (const field of ['email', 'code', 'newPassword', 'confirmPassword'] as ResetField[]) {
      const message = this.messageFor(field);
      if (message) errors[field] = message;
    }
    this.errors.set(errors);
    return !Object.keys(errors).length;
  }

  async submit(): Promise<void> {
    if (this.submitting() || !this.available() || !this.validate()) return;
    this.submitting.set(true);
    this.pageError.set('');
    try {
      await this.auth.resetPassword(this.email.trim(), this.code.replace(/\s/g, ''), this.newPassword);
      this.succeeded.set(true);
      this.code = '';
      this.newPassword = '';
      this.confirmPassword = '';
    } catch (error) {
      // Keep everything typed; just point at the field that needs fixing.
      this.errors.update((current) => ({ ...current, ...(apiFieldErrors(error) as ResetErrors) }));
      this.pageError.set(apiErrorMessage(error));
    } finally {
      this.submitting.set(false);
    }
  }

  private messageFor(field: ResetField): string | null {
    switch (field) {
      case 'email': return validateEmail(this.email);
      case 'code': return validateResetCode(this.code);
      case 'newPassword': return validatePassword(this.newPassword);
      case 'confirmPassword': return validateConfirmPassword(this.newPassword, this.confirmPassword);
    }
  }

  private reset(): void {
    this.email = '';
    this.code = '';
    this.newPassword = '';
    this.confirmPassword = '';
    this.errors.set({});
    this.pageError.set('');
    this.succeeded.set(false);
    this.emailFromRequest.set(false);
  }
}
