/**
 * @file security.page.ts
 * @description Authenticated password-change form with inline validation and session replacement.
 */
import { HttpErrorResponse } from '@angular/common/http';
import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import {
  IonBackButton,
  IonButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonIcon,
  IonInput,
  IonInputPasswordToggle,
  IonSpinner,
  IonTitle,
  IonToolbar,
} from '@ionic/angular';
import { apiErrorMessage, apiFieldErrors } from '../../core/api-error';
import { AccountStatus, AuthService } from '../../core/auth.service';
import { validateConfirmPassword, validatePassword } from '../../core/signup-rules';
import { UiService } from '../../core/ui.service';
import { PasswordRequirementsComponent } from '../../components/password-requirements.component';

type SecurityField = 'currentPassword' | 'newPassword' | 'confirmPassword';
type SecurityErrors = Partial<Record<SecurityField, string>>;

@Component({
  selector: 'app-security',
  templateUrl: 'security.page.html',
  styleUrls: ['security.page.scss'],
  imports: [
    FormsModule,
    IonHeader,
    IonToolbar,
    IonButtons,
    IonBackButton,
    IonTitle,
    IonContent,
    IonInput,
    IonInputPasswordToggle,
    IonButton,
    IonIcon,
    IonSpinner,
    PasswordRequirementsComponent,
  ],
})
export class SecurityPage {
  private auth = inject(AuthService);
  private router = inject(Router);
  private ui = inject(UiService);

  readonly user = this.auth.user;
  readonly saving = signal(false);
  readonly succeeded = signal(false);
  readonly pageError = signal('');
  readonly errors = signal<SecurityErrors>({});
  readonly touched = signal<ReadonlySet<SecurityField>>(new Set());

  readonly accountStatus = signal<AccountStatus | null>(null);
  readonly statusLoading = signal(false);

  currentPassword = '';
  newPassword = '';
  confirmPassword = '';

  async ionViewWillEnter(): Promise<void> {
    if (!this.auth.isLoggedIn()) {
      await this.router.navigate(['/login'], {
        queryParams: { returnUrl: '/profile/security' },
        replaceUrl: true,
      });
      return;
    }
    await this.loadAccountStatus();
  }

  /** Loads the read-only sign-in-methods summary; failure hides the panel without blocking password change. */
  async loadAccountStatus(): Promise<void> {
    this.statusLoading.set(true);
    try {
      this.accountStatus.set(await this.auth.accountStatus());
    } catch {
      this.accountStatus.set(null);
    } finally {
      this.statusLoading.set(false);
    }
  }

  update(field: SecurityField, value: string | null | undefined): void {
    this[field] = value ?? '';
    this.pageError.set('');
    this.succeeded.set(false);
    if (this.touched().has(field) || this.errors()[field]) this.validateField(field);
    if (field === 'newPassword' && this.touched().has('confirmPassword')) this.validateField('confirmPassword');
  }

  blur(field: SecurityField): void {
    this.touched.update((current) => new Set(current).add(field));
    this.validateField(field);
  }

  fieldError(field: SecurityField): string | undefined {
    return this.errors()[field];
  }

  isTouched(field: SecurityField): boolean {
    return this.touched().has(field);
  }

  async submit(): Promise<void> {
    if (this.saving()) return;
    const errors = this.validateAll();
    this.touched.set(new Set<SecurityField>(['currentPassword', 'newPassword', 'confirmPassword']));
    this.errors.set(errors);
    if (Object.keys(errors).length) return;

    this.saving.set(true);
    this.pageError.set('');
    try {
      await this.auth.changePassword(this.currentPassword, this.newPassword);
      this.currentPassword = '';
      this.newPassword = '';
      this.confirmPassword = '';
      this.touched.set(new Set());
      this.errors.set({});
      this.succeeded.set(true);
      await this.ui.toast('Password changed securely.', { icon: 'checkmark-circle' });
    } catch (error) {
      if (error instanceof HttpErrorResponse && error.status === 401) {
        this.auth.logout();
        await this.router.navigate(['/login'], {
          queryParams: { returnUrl: '/profile/security' },
          replaceUrl: true,
        });
        return;
      }
      const fieldErrors = apiFieldErrors(error) as SecurityErrors;
      this.errors.update((current) => ({ ...current, ...fieldErrors }));
      this.pageError.set(apiErrorMessage(error));
    } finally {
      this.saving.set(false);
    }
  }

  private validateField(field: SecurityField): void {
    const message = this.validateAll()[field];
    this.errors.update((current) => ({ ...current, [field]: message }));
  }

  private validateAll(): SecurityErrors {
    const errors: SecurityErrors = {};
    if (!this.currentPassword) errors.currentPassword = 'Enter your current password.';
    const user = this.auth.user();
    const passwordError = validatePassword(this.newPassword, {
      email: user?.email,
      firstName: user?.firstName,
      lastName: user?.lastName,
    });
    if (passwordError) errors.newPassword = passwordError;
    const confirmError = validateConfirmPassword(this.newPassword, this.confirmPassword);
    if (confirmError) errors.confirmPassword = confirmError;
    return errors;
  }
}
