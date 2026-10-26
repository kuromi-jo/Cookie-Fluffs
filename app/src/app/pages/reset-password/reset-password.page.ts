/**
 * @file reset-password.page.ts
 * @description In-memory reset-token consumption with immediate URL-fragment removal.
 */
import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, RouterLink } from '@angular/router';
import {
  IonBackButton, IonButton, IonButtons, IonContent, IonHeader, IonIcon, IonInput,
  IonInputPasswordToggle, IonSpinner, IonTitle, IonToolbar,
} from '@ionic/angular';
import { apiErrorMessage, apiFieldErrors } from '../../core/api-error';
import { AuthService } from '../../core/auth.service';
import { validateConfirmPassword, validatePassword } from '../../core/signup-rules';
import { PasswordRequirementsComponent } from '../../components/password-requirements.component';

type ResetField = 'newPassword' | 'confirmPassword';
type ResetErrors = Partial<Record<ResetField, string>>;

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
  private route = inject(ActivatedRoute);
  private selector = '';
  private token = '';
  private linkCaptured = false;

  readonly loading = signal(true);
  readonly available = signal(false);
  readonly linkValid = signal(false);
  readonly submitting = signal(false);
  readonly succeeded = signal(false);
  readonly pageError = signal('');
  readonly errors = signal<ResetErrors>({});
  newPassword = '';
  confirmPassword = '';

  async ionViewWillEnter(): Promise<void> {
    if (!this.linkCaptured) {
      this.selector = this.route.snapshot.queryParamMap.get('selector') ?? '';
      try {
        this.token = this.route.snapshot.fragment?.startsWith('token=')
          ? decodeURIComponent(this.route.snapshot.fragment.slice(6)) : '';
      } catch {
        this.token = '';
      }
      this.linkCaptured = true;
      if (globalThis.history && globalThis.location) {
        globalThis.history.replaceState(null, '', `${globalThis.location.pathname}${globalThis.location.search}`);
      }
    }
    this.linkValid.set(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(this.selector)
      && /^[A-Za-z0-9_-]{43}$/.test(this.token),
    );
    try {
      this.available.set((await this.auth.passwordRecoveryConfig()).enabled);
    } catch {
      this.available.set(false);
    } finally {
      this.loading.set(false);
    }
  }

  ionViewDidLeave(): void {
    this.selector = '';
    this.token = '';
    this.linkCaptured = false;
  }

  update(field: ResetField, value: string | null | undefined): void {
    this[field] = value ?? '';
    this.pageError.set('');
    if (this.errors()[field]) this.validate();
  }

  validate(): boolean {
    const errors: ResetErrors = {};
    const passwordError = validatePassword(this.newPassword);
    if (passwordError) errors.newPassword = passwordError;
    const confirmError = validateConfirmPassword(this.newPassword, this.confirmPassword);
    if (confirmError) errors.confirmPassword = confirmError;
    this.errors.set(errors);
    return !Object.keys(errors).length;
  }

  async submit(): Promise<void> {
    if (this.submitting() || !this.available() || !this.linkValid() || !this.validate()) return;
    this.submitting.set(true);
    this.pageError.set('');
    try {
      await this.auth.resetPassword(this.selector, this.token, this.newPassword);
      this.token = '';
      this.selector = '';
      this.newPassword = '';
      this.confirmPassword = '';
      this.succeeded.set(true);
    } catch (error) {
      this.errors.update((current) => ({ ...current, ...(apiFieldErrors(error) as ResetErrors) }));
      this.pageError.set(apiErrorMessage(error));
    } finally {
      this.submitting.set(false);
    }
  }
}
