/**
 * @file profile.page.ts
 * @description Authenticated customer profile and editable personal information.
 */
import { NotificationSheetService } from '../../core/notification-sheet.service';
import { Component, computed, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { HttpErrorResponse } from '@angular/common/http';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import {
  AlertController,
  IonButton,
  IonButtons,
  IonContent,
  IonDatetime,
  IonHeader,
  IonIcon,
  IonInput,
  IonMenuButton,
  IonModal,
  IonSelect,
  IonSelectOption,
  IonSpinner,
  IonTitle,
  IonToolbar,
  ModalController,
} from '@ionic/angular';
import { AvatarComponent } from '../../components/avatar.component';
import { VerificationModalComponent } from '../../components/verification-modal.component';
import { apiErrorMessage, apiFieldErrors } from '../../core/api-error';
import { AuthService } from '../../core/auth.service';
import { GoogleAuthService } from '../../core/google-auth.service';
import { VerificationService } from '../../core/verification.service';
import { GoogleReauthModalComponent } from '../../components/google-reauth-modal.component';
import { NotificationService } from '../../core/notification.service';
import { fileToAvatar } from '../../core/image';
import { Gender, User } from '../../core/models';
import { validateFirstName, validateLastName } from '../../core/signup-rules';
import { UiService } from '../../core/ui.service';

type ProfileField = 'firstName' | 'lastName' | 'dateOfBirth';
type ProfileErrors = Partial<Record<ProfileField, string>>;

export interface ProfileDraft {
  firstName: string;
  lastName: string;
  avatar: string | null;
  gender: Gender | null;
  dateOfBirth: string | null;
}

export function profileDraft(user: User): ProfileDraft {
  return {
    firstName: user.firstName ?? user.fullName.split(' ')[0] ?? '',
    lastName: user.lastName ?? user.fullName.split(' ').slice(1).join(' '),
    avatar: user.avatar,
    gender: user.gender ?? null,
    dateOfBirth: user.dateOfBirth ?? null,
  };
}

/** Rejects empty (allowed), non-calendar, or future dates. Mirrors the server validator. */
export function validateDateOfBirth(value: string | null): string | null {
  if (!value) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return 'Enter your date of birth as YYYY-MM-DD.';
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return 'Enter a real calendar date.';
  }
  const now = new Date();
  if (date.getTime() > Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())) {
    return 'Date of birth cannot be in the future.';
  }
  if (year < 1900) return 'Enter a valid date of birth.';
  return null;
}

export function validateProfile(draft: ProfileDraft): ProfileErrors {
  const errors: ProfileErrors = {};
  const firstName = validateFirstName(draft.firstName);
  const lastName = validateLastName(draft.lastName);
  const dateOfBirth = validateDateOfBirth(draft.dateOfBirth);
  if (firstName) errors.firstName = firstName;
  if (lastName) errors.lastName = lastName;
  if (dateOfBirth) errors.dateOfBirth = dateOfBirth;
  return errors;
}

@Component({
  selector: 'app-profile',
  templateUrl: 'profile.page.html',
  styleUrls: ['profile.page.scss'],
  imports: [
    FormsModule,
    RouterLink,
    DatePipe,
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
    IonSelect,
    IonSelectOption,
    IonDatetime,
    IonModal,
    IonSpinner,
  ],
})
export class ProfilePage {
  private notificationSheet = inject(NotificationSheetService);
  /** The bell opens notifications as a slide-up sheet over this page. */
  openNotifications(): void {
    void this.notificationSheet.open();
  }

  readonly auth = inject(AuthService);
  readonly notifications = inject(NotificationService);
  private router = inject(Router);
  private alerts = inject(AlertController);
  private modals = inject(ModalController);
  private ui = inject(UiService);
  private google = inject(GoogleAuthService);
  private verification = inject(VerificationService);

  readonly loading = signal(true);
  readonly loadError = signal('');
  readonly editing = signal(false);
  readonly saving = signal(false);
  /** True while the final Change Phone API call is in flight, to block repeated confirmation. */
  readonly changingPhone = signal(false);
  /** True while the final Change Email API call is in flight, to block repeated confirmation. */
  readonly changingEmail = signal(false);
  /** True while the final Set Password API call is in flight, to block repeated confirmation. */
  readonly settingPassword = signal(false);
  /** True when the account has no password yet (Google-only) and may set one. */
  readonly canSetPassword = computed(() => this.auth.user()?.hasPassword === false);
  readonly pageError = signal('');
  readonly errors = signal<ProfileErrors>({});
  readonly touched = signal<ReadonlySet<ProfileField>>(new Set());
  readonly draft = signal<ProfileDraft>({
    firstName: '', lastName: '', avatar: null, gender: null, dateOfBirth: null,
  });
  readonly genderOptions: { value: Gender; label: string }[] = [
    { value: 'female', label: 'Female' },
    { value: 'male', label: 'Male' },
    { value: 'non_binary', label: 'Non-binary' },
    { value: 'prefer_not_to_say', label: 'Prefer not to say' },
  ];
  /** Upper bound for the date picker: today (no future birthdates). */
  readonly maxBirthDate = new Date().toISOString().slice(0, 10);
  private avatarChanged = false;

  /** True when the edit form differs from the saved profile, so Save can be disabled otherwise. */
  readonly hasChanges = computed(() => {
    const user = this.auth.user();
    if (!user) return false;
    const saved = profileDraft(user);
    const draft = this.draft();
    return draft.firstName.trim() !== saved.firstName.trim()
      || draft.lastName.trim() !== saved.lastName.trim()
      || (draft.gender ?? null) !== (saved.gender ?? null)
      || (draft.dateOfBirth ?? null) !== (saved.dateOfBirth ?? null)
      || this.avatarChanged;
  });

  async ionViewWillEnter(): Promise<void> {
    if (!this.auth.isLoggedIn()) {
      await this.router.navigate(['/login'], { queryParams: { returnUrl: '/profile' }, replaceUrl: true });
      return;
    }
    await this.loadProfile();
    void this.notifications.refreshUnread();
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

  setGender(value: Gender | null): void {
    this.draft.update((current) => ({ ...current, gender: value || null }));
    this.pageError.set('');
  }

  setDateOfBirth(value: string | null): void {
    const normalized = value ? value.slice(0, 10) : null;
    this.draft.update((current) => ({ ...current, dateOfBirth: normalized }));
    this.pageError.set('');
    if (this.touched().has('dateOfBirth') || this.errors().dateOfBirth) this.validateField('dateOfBirth');
  }

  clearDateOfBirth(): void {
    this.setDateOfBirth(null);
  }

  /** Clears the draft photo so saving removes the stored avatar and shows the initials fallback. */
  removePhoto(): void {
    if (!this.draft().avatar) return;
    this.draft.update((current) => ({ ...current, avatar: null }));
    this.avatarChanged = true;
    this.pageError.set('');
  }

  async save(): Promise<void> {
    if (this.saving()) return;
    const errors = validateProfile(this.draft());
    this.touched.set(new Set<ProfileField>(['firstName', 'lastName', 'dateOfBirth']));
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
        gender: draft.gender,
        dateOfBirth: draft.dateOfBirth,
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

  /** Masks a phone like +6391••••4567 for display of protected numbers. */
  maskedPhone(phone: string | null | undefined): string {
    const value = String(phone ?? '').trim();
    if (value.length < 6) return value || '—';
    return `${value.slice(0, 5)}${'•'.repeat(Math.max(2, value.length - 9))}${value.slice(-4)}`;
  }

  /** Normalizes a PH mobile number to +639XXXXXXXXX, mirroring the server. Null if invalid. */
  private normalizePhPhone(value: string): string | null {
    const cleaned = String(value ?? '').replace(/[\s\-()]/g, '');
    if (!/^(?:\+63|63|0)9\d{9}$/.test(cleaned)) return null;
    return `+639${cleaned.slice(-9)}`;
  }

  /**
   * Protected Change Phone flow: collect a new PH number, verify identity via the shared
   * verification sheet (operation change_phone, target = normalized new number), then require an
   * EXPLICIT final confirmation before applying. Verifying the OTP alone never changes the number;
   * the challenge stays in the server's VERIFIED-but-unconsumed state until the customer presses
   * "Confirm change", at which point the backend atomically consumes it and updates the phone.
   * The same normalized number is used for start/verify/change so the server's target binding
   * matches. Cancelling or dismissing the confirmation leaves the phone unchanged and lets the
   * authorization expire unused.
   */
  async startChangePhone(): Promise<void> {
    const prompt = await this.alerts.create({
      header: 'Change mobile number',
      message: 'Enter your new Philippine mobile number. We\u2019ll verify your identity before saving it.',
      inputs: [{ name: 'phone', type: 'tel', placeholder: '0917 123 4567', attributes: { inputmode: 'tel' } }],
      buttons: [
        { text: 'Cancel', role: 'cancel' },
        { text: 'Continue', role: 'confirm' },
      ],
      cssClass: 'cf-alert-confirm',
    });
    await prompt.present();
    const { role, data } = await prompt.onDidDismiss();
    if (role !== 'confirm') return;

    const normalized = this.normalizePhPhone(data?.values?.phone ?? '');
    if (!normalized) {
      await this.ui.toast('Enter a Philippine mobile number, like 0917 123 4567.', { error: true });
      return;
    }

    const modal = await this.modals.create({
      component: VerificationModalComponent,
      componentProps: { operation: 'change_phone', target: normalized },
      cssClass: 'verify-sheet-modal',
    });
    await modal.present();
    const result = await modal.onDidDismiss();
    if (result.role !== 'verified' || !result.data?.challengeId) return;

    // Identity is verified, but the change is NOT applied yet. Require an explicit confirmation
    // that shows the masked current and proposed numbers before the single protected API call.
    await this.confirmAndApplyPhoneChange(result.data.challengeId, normalized);
  }

  /**
   * Final confirmation gate for Change Phone. Shows masked current/proposed numbers and a clear
   * note that email verification authenticated the customer but does not prove ownership of the
   * new number. Only an explicit "Confirm change" triggers POST /api/auth/change-phone, exactly
   * once; cancel/backdrop dismiss makes no API call and leaves the phone unchanged.
   */
  private async confirmAndApplyPhoneChange(challengeId: string, normalized: string): Promise<void> {
    if (this.changingPhone()) return; // guard against overlapping flows
    const current = this.maskedPhone(this.auth.user()?.phone);
    const proposed = this.maskedPhone(normalized);
    const confirm = await this.alerts.create({
      header: 'Confirm your new number',
      message:
        `Change your mobile number from ${current} to ${proposed}? `
        + 'Email verification confirmed it\u2019s you, but it does not prove you own this new number. '
        + 'Make sure it\u2019s correct before confirming.',
      buttons: [
        { text: 'Confirm change', role: 'confirm' },
        { text: 'Cancel', role: 'cancel' },
      ],
      cssClass: 'cf-alert-confirm',
    });
    await confirm.present();
    const { role } = await confirm.onDidDismiss();
    if (role !== 'confirm') return; // cancel or backdrop dismiss: no API call, phone unchanged

    if (this.changingPhone()) return; // block a double confirm while a request is pending
    this.changingPhone.set(true);
    try {
      await this.auth.changePhone(challengeId, normalized);
      await this.notifications.refreshUnread();
      await this.ui.toast('Mobile number updated.', { icon: 'checkmark-circle' });
    } catch (error) {
      // A 409 here means the verified authorization expired/was consumed before confirmation.
      const message = apiErrorMessage(error);
      this.pageError.set(message);
      await this.ui.toast(message, { error: true });
    } finally {
      this.changingPhone.set(false);
    }
  }

  /** Masks an email like m•••@example.com for safe display of the protected address. */
  maskedEmail(email: string | null | undefined): string {
    const value = String(email ?? '').trim();
    const at = value.indexOf('@');
    if (at < 1) return value || '—';
    const head = value.slice(0, 1);
    return `${head}${'•'.repeat(Math.max(2, at - 1))}${value.slice(at)}`;
  }

  /** Normalizes an email the same way the server does (trim + lowercase). */
  private normalizeEmail(value: string | null | undefined): string {
    return String(value ?? '').trim().toLowerCase();
  }

  /**
   * Protected Change Email flow: enter new email, MANDATORY reauthentication (current password,
   * or Google for Google-only accounts), verify the OTP sent to the NEW email, then an explicit
   * final confirmation showing masked old and new addresses. Only the confirmation calls the
   * change endpoint, which atomically consumes both proofs, updates the email, and rotates the
   * session. Cancelling at any step changes nothing.
   */
  async startChangeEmail(): Promise<void> {
    const prompt = await this.alerts.create({
      header: 'Change email address',
      message: 'Enter your new email. We\u2019ll confirm it\u2019s you, then send a code to the new address.',
      inputs: [{ name: 'email', type: 'email', placeholder: 'name@example.com', attributes: { inputmode: 'email' } }],
      buttons: [
        { text: 'Cancel', role: 'cancel' },
        { text: 'Continue', role: 'confirm' },
      ],
      cssClass: 'cf-alert-confirm',
    });
    await prompt.present();
    const { role, data } = await prompt.onDidDismiss();
    if (role !== 'confirm') return;

    const newEmail = this.normalizeEmail(data?.values?.email ?? '');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(newEmail) || newEmail.length > 254) {
      await this.ui.toast('Enter a valid email address, like name@example.com.', { error: true });
      return;
    }
    if (newEmail === this.normalizeEmail(this.auth.user()?.email)) {
      await this.ui.toast('That is already your email address.', { error: true });
      return;
    }

    // Mandatory step-up reauthentication before anything else.
    let reauthId: string;
    try {
      const proof = await this.reauthenticateForEmail();
      if (!proof) return; // user cancelled reauth
      reauthId = proof;
    } catch (error) {
      await this.ui.toast(apiErrorMessage(error), { error: true });
      return;
    }

    // Verify ownership of the NEW address (OTP delivered there by the server).
    const modal = await this.modals.create({
      component: VerificationModalComponent,
      componentProps: { operation: 'change_email', target: newEmail },
      cssClass: 'verify-sheet-modal',
    });
    await modal.present();
    const result = await modal.onDidDismiss();
    if (result.role !== 'verified' || !result.data?.challengeId) return;

    await this.confirmAndApplyEmailChange(reauthId, result.data.challengeId, newEmail);
  }

  /**
   * Mandatory reauthentication. Local-password accounts enter their current password; Google-only
   * accounts (no password) reauthenticate with Google. Returns an opaque single-use proof id, or
   * null if the customer cancels. Never stores or echoes the password or token.
   */
  private async reauthenticateForEmail(): Promise<string | null> {
    const hasPassword = this.auth.user()?.hasPassword !== false;
    if (!hasPassword) {
      return this.reauthWithGoogle();
    }
    const prompt = await this.alerts.create({
      header: 'Confirm it\u2019s you',
      message: 'Enter your current password to continue changing your email.',
      inputs: [{ name: 'password', type: 'password', attributes: { autocomplete: 'current-password' } }],
      buttons: [
        { text: 'Cancel', role: 'cancel' },
        { text: 'Confirm', role: 'confirm' },
      ],
      cssClass: 'cf-alert-confirm',
    });
    await prompt.present();
    const { role, data } = await prompt.onDidDismiss();
    if (role !== 'confirm') return null;
    const password = String(data?.values?.password ?? '');
    if (!password) {
      await this.ui.toast('Enter your current password.', { error: true });
      return null;
    }
    return this.auth.reauthPassword(password);
  }

  /**
   * Google step-up for Google-only accounts. Uses a PURPOSE-BOUND reauth nonce (not the
   * login/signup nonce) and collects a fresh Google ID token with the platform-appropriate
   * mechanism: the native plugin on Android, Google Identity Services in a web browser. The token
   * is exchanged for an opaque reauth proof; the app session is never replaced. Returns null if
   * the customer cancels or Google is unavailable.
   */
  private async reauthWithGoogle(operation: 'change_email' | 'set_password' = 'change_email'): Promise<string | null> {
    const config = await this.auth.googleAuthConfig();
    if (!config.enabled || !config.webClientId) {
      await this.ui.toast('Google sign-in is unavailable right now.', { error: true });
      return null;
    }
    // Purpose-bound reauth nonce for THIS authenticated, Google-linked customer.
    const issued = await this.verification.googleReauthNonce();

    let idToken: string | null;
    if (this.google.isNativeAndroid) {
      idToken = await this.google.nativeIdToken(config.webClientId, issued.nonce);
    } else {
      // Web: collect a fresh token through GIS in a bounded modal (handles cancel/blocked/unavailable).
      const modal = await this.modals.create({
        component: GoogleReauthModalComponent,
        componentProps: { webClientId: config.webClientId, nonce: issued.nonce, operation },
        cssClass: 'verify-sheet-modal',
      });
      await modal.present();
      const result = await modal.onDidDismiss<string>();
      idToken = result.role === 'reauthed' && result.data ? result.data : null;
    }
    if (!idToken) return null; // cancelled, blocked, or unavailable: no proof, no change

    return this.auth.reauthGoogle(issued.selector, issued.nonce, idToken, operation);
  }

  /**
   * Set Password for a Google-only account: mandatory Google reauthentication, then an email OTP
   * to the registered address, then enter+confirm a new password, then an explicit final
   * confirmation. Only the confirmation calls the protected endpoint, which atomically consumes
   * both proofs, stores the hash, and rotates the session. Available only when hasPassword===false.
   */
  async startSetPassword(): Promise<void> {
    if (!this.canSetPassword()) return;

    // Mandatory Google step-up first (Google-only accounts have no password).
    let reauthId: string | null;
    try {
      reauthId = await this.reauthWithGoogle('set_password');
    } catch (error) {
      await this.ui.toast(apiErrorMessage(error), { error: true });
      return;
    }
    if (!reauthId) return; // cancelled / unavailable

    // Verify ownership of the registered email via the set_password OTP (no target needed).
    const modal = await this.modals.create({
      component: VerificationModalComponent,
      componentProps: { operation: 'set_password', target: null },
      cssClass: 'verify-sheet-modal',
    });
    await modal.present();
    const verified = await modal.onDidDismiss();
    if (verified.role !== 'verified' || !verified.data?.challengeId) return;

    // Collect and confirm the new password.
    const prompt = await this.alerts.create({
      header: 'Set a password',
      message: 'Create a password (at least 8 characters). You\u2019ll be able to log in with your '
        + 'email and password as well as Google.',
      inputs: [
        { name: 'password', type: 'password', placeholder: 'New password', attributes: { autocomplete: 'new-password' } },
        { name: 'confirm', type: 'password', placeholder: 'Confirm password', attributes: { autocomplete: 'new-password' } },
      ],
      buttons: [
        { text: 'Cancel', role: 'cancel' },
        { text: 'Continue', role: 'confirm' },
      ],
      cssClass: 'cf-alert-confirm',
    });
    await prompt.present();
    const { role, data } = await prompt.onDidDismiss();
    if (role !== 'confirm') return;
    const password = String(data?.values?.password ?? '');
    const confirm = String(data?.values?.confirm ?? '');
    if (password.length < 8 || password.length > 64) {
      await this.ui.toast('Password needs 8 to 64 characters.', { error: true });
      return;
    }
    if (password !== confirm) {
      await this.ui.toast('Those passwords don\u2019t match. Try again.', { error: true });
      return;
    }

    await this.confirmAndApplySetPassword(reauthId, verified.data.challengeId, password);
  }

  /**
   * Final confirmation gate for Set Password. Only an explicit "Set password" confirmation calls
   * the endpoint, once. Cancel/backdrop sets nothing. Password is never persisted anywhere.
   */
  private async confirmAndApplySetPassword(reauthId: string, challengeId: string, newPassword: string): Promise<void> {
    if (this.settingPassword()) return;
    const confirm = await this.alerts.create({
      header: 'Confirm new password',
      message: 'Set this password for your account? Other devices will be signed out, and you\u2019ll '
        + 'use it with your email to log in.',
      buttons: [
        { text: 'Set password', role: 'confirm' },
        { text: 'Cancel', role: 'cancel' },
      ],
      cssClass: 'cf-alert-confirm',
    });
    await confirm.present();
    const { role } = await confirm.onDidDismiss();
    if (role !== 'confirm') return;

    if (this.settingPassword()) return;
    this.settingPassword.set(true);
    try {
      await this.auth.setPassword(reauthId, challengeId, newPassword);
      await this.notifications.refreshUnread();
      await this.ui.toast('Password set.', { icon: 'checkmark-circle' });
    } catch (error) {
      const message = apiErrorMessage(error);
      this.pageError.set(message);
      await this.ui.toast(message, { error: true });
    } finally {
      this.settingPassword.set(false);
    }
  }

  /**
   * Final confirmation gate for Change Email. Shows masked current/new addresses and states that
   * future login uses the new email. Only an explicit "Confirm change" calls the endpoint, once.
   */
  private async confirmAndApplyEmailChange(reauthId: string, challengeId: string, newEmail: string): Promise<void> {
    if (this.changingEmail()) return;
    const current = this.maskedEmail(this.auth.user()?.email);
    const proposed = this.maskedEmail(newEmail);
    const confirm = await this.alerts.create({
      header: 'Confirm your new email',
      message:
        `Change your email from ${current} to ${proposed}? `
        + 'You\u2019ll use the new email to log in, and other devices will be signed out.',
      buttons: [
        { text: 'Confirm change', role: 'confirm' },
        { text: 'Cancel', role: 'cancel' },
      ],
      cssClass: 'cf-alert-confirm',
    });
    await confirm.present();
    const { role } = await confirm.onDidDismiss();
    if (role !== 'confirm') return;

    if (this.changingEmail()) return;
    this.changingEmail.set(true);
    try {
      await this.auth.changeEmail(reauthId, challengeId, newEmail);
      await this.notifications.refreshUnread();
      await this.ui.toast('Email address updated.', { icon: 'checkmark-circle' });
    } catch (error) {
      const message = apiErrorMessage(error);
      this.pageError.set(message);
      await this.ui.toast(message, { error: true });
    } finally {
      this.changingEmail.set(false);
    }
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
    const field = (['firstName', 'lastName', 'dateOfBirth'] as ProfileField[]).find((candidate) => errors[candidate]);
    if (!field) return;
    await new Promise((resolve) => setTimeout(resolve));
    const input = document.getElementById(`profile-${field}`) as (HTMLElement & { setFocus?: () => Promise<void> }) | null;
    input?.scrollIntoView({ behavior: 'auto', block: 'center' });
    await input?.setFocus?.();
  }
}
