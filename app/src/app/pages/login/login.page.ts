/**
 * @file login.page.ts
 * @description Accessible login and signup flow with inline validation.
 */
import { Component, inject, input, signal, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import {
  IonBackButton,
  IonButton,
  IonButtons,
  IonCheckbox,
  IonContent,
  IonHeader,
  IonIcon,
  IonInput,
  IonInputPasswordToggle,
  IonLabel,
  IonSegment,
  IonSegmentButton,
  IonSpinner,
  IonToolbar,
  CheckboxCustomEvent,
  ModalController,
  NavController,
} from '@ionic/angular';
import { AuthService } from '../../core/auth.service';
import { UiService } from '../../core/ui.service';
import { apiErrorMessage, apiFieldErrors } from '../../core/api-error';
import {
  hasEnoughDifferentCharacters,
  passwordContainsPersonalInfo,
  passwordHasLowercase,
  passwordHasNumber,
  passwordHasSpecialCharacter,
  passwordHasUppercase,
  passwordLengthIsValid,
  validateEmail,
  validateConfirmPassword,
  validateFirstName,
  validateLastName,
  validatePassword,
  validatePhone,
} from '../../core/signup-rules';
import { ConsentModalComponent } from '../../components/consent-modal.component';
import { prefersReducedMotion } from '../../core/preference.service';

type Mode = 'login' | 'signup';
type FieldName = 'firstName' | 'lastName' | 'email' | 'phone' | 'password' | 'confirmPassword' | 'terms';
type TextField = Exclude<FieldName, 'terms'>;
type FieldErrors = Partial<Record<FieldName, string>>;
type StrengthLevel = 'neutral' | 'short' | 'easy' | 'okay' | 'strong';

const SIGNUP_FIELDS: FieldName[] = ['firstName', 'lastName', 'email', 'phone', 'password', 'confirmPassword', 'terms'];
const LOGIN_FIELDS: FieldName[] = ['email', 'password'];
const FOCUS_ORDER: FieldName[] = ['firstName', 'lastName', 'email', 'phone', 'password', 'confirmPassword', 'terms'];

@Component({
  selector: 'app-login',
  templateUrl: 'login.page.html',
  styleUrls: ['login.page.scss'],
  imports: [
    FormsModule,
    RouterLink,
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
    IonCheckbox,
    IonButton,
    IonIcon,
    IonSpinner,
  ],
})
export class LoginPage {
  /** Where to go after logging in (query param ?returnUrl=/cart). */
  readonly returnUrl = input<string>();

  private auth = inject(AuthService);
  private ui = inject(UiService);
  private nav = inject(NavController);
  private router = inject(Router);
  private modals = inject(ModalController);

  private readonly firstNameInput = viewChild<IonInput>('firstNameInput');
  private readonly lastNameInput = viewChild<IonInput>('lastNameInput');
  private readonly emailInput = viewChild<IonInput>('emailInput');
  private readonly phoneInput = viewChild<IonInput>('phoneInput');
  private readonly passwordInput = viewChild<IonInput>('passwordInput');
  private readonly confirmPasswordInput = viewChild<IonInput>('confirmPasswordInput');
  private readonly termsInput = viewChild<IonCheckbox>('termsInput');

  readonly mode = signal<Mode>('login');
  readonly submitting = signal(false);
  readonly error = signal<string | null>(null);
  readonly fieldErrors = signal<FieldErrors>({});
  readonly touched = signal<ReadonlySet<FieldName>>(new Set());
  readonly submitted = signal(false);

  email = '';
  password = '';
  firstName = '';
  lastName = '';
  phone = '';
  confirmPassword = '';
  acceptedTerms = false;
  private consentUnlocked = false;
  private consentOpening = false;

  setMode(value: unknown): void {
    if (value === 'login' || value === 'signup') {
      this.mode.set(value);
      this.error.set(null);
      this.fieldErrors.set({});
      this.touched.set(new Set());
      this.submitted.set(false);
    }
  }

  updateText(field: TextField, value: string | null | undefined): void {
    const text = value ?? '';
    this.error.set(null);
    switch (field) {
      case 'firstName':
        this.firstName = text;
        break;
      case 'lastName':
        this.lastName = text;
        break;
      case 'email':
        this.email = text;
        break;
      case 'phone':
        this.phone = text;
        break;
      case 'password':
        this.password = text;
        break;
      case 'confirmPassword':
        this.confirmPassword = text;
        break;
    }

    this.revalidateIfVisible(field);
    if (field === 'password') this.revalidateIfVisible('confirmPassword');
    if (field === 'firstName' || field === 'lastName' || field === 'email') this.revalidateIfVisible('password');
  }

  updateTerms(value: boolean): void {
    this.acceptedTerms = value;
    this.error.set(null);
    this.revalidateIfVisible('terms');
  }

  onTermsChange(event: CheckboxCustomEvent): void {
    if (!event.detail.checked) {
      this.updateTerms(false);
      return;
    }
    if (this.consentUnlocked) {
      this.updateTerms(true);
      return;
    }

    event.target.checked = false;
    this.acceptedTerms = false;
    void this.openConsent();
  }

  blurField(field: FieldName): void {
    this.markTouched([field]);
    this.setFieldError(field, this.validateField(field));
  }

  fieldError(field: FieldName): string | null {
    return this.fieldErrors()[field] ?? null;
  }

  isTouched(field: FieldName): boolean {
    return this.touched().has(field);
  }

  passwordLengthOkay(): boolean {
    return passwordLengthIsValid(this.password);
  }

  passwordUppercaseOkay(): boolean {
    return passwordHasUppercase(this.password);
  }

  passwordLowercaseOkay(): boolean {
    return passwordHasLowercase(this.password);
  }

  passwordNumberOkay(): boolean {
    return passwordHasNumber(this.password);
  }

  passwordSpecialCharacterOkay(): boolean {
    return passwordHasSpecialCharacter(this.password);
  }

  passwordPersonalInfoOkay(): boolean {
    return this.password.length > 0 &&
      !passwordContainsPersonalInfo(this.password, this.email, this.firstName, this.lastName);
  }

  passwordStrength(): { level: StrengthLevel; label: string; segments: number } {
    if (!this.password) return { level: 'neutral', label: '', segments: 0 };
    if ([...this.password].length < 8) return { level: 'short', label: 'Too short', segments: 1 };
    const policyError = validatePassword(this.password, {
      email: this.email,
      firstName: this.firstName,
      lastName: this.lastName,
    });
    if (policyError || !hasEnoughDifferentCharacters(this.password)) {
      return { level: 'easy', label: 'Too easy to guess', segments: 1 };
    }
    if ([...this.password].length < 12) return { level: 'okay', label: 'Okay', segments: 2 };
    return { level: 'strong', label: 'Strong', segments: 3 };
  }

  async submit(): Promise<void> {
    this.error.set(null);
    this.submitted.set(true);
    const fields = this.mode() === 'signup' ? SIGNUP_FIELDS : LOGIN_FIELDS;
    const errors = this.validateFields(fields);
    this.markTouched(fields);
    this.fieldErrors.set(errors);
    if (Object.keys(errors).length) {
      await this.focusFirstError(errors);
      return;
    }

    this.submitting.set(true);
    try {
      const user =
        this.mode() === 'login'
          ? await this.auth.login(this.email, this.password)
          : await this.auth.signup({
              firstName: this.firstName,
              lastName: this.lastName,
              email: this.email,
              phone: this.phone,
              password: this.password,
            });

      const first = user.firstName ?? user.fullName.split(' ')[0];
      const welcome = this.mode() === 'login' ? `Welcome back, ${first}!` : `Welcome to Cookie Fluffs, ${first}!`;
      this.password = '';
      this.confirmPassword = '';
      const target = this.returnUrl();
      await this.nav.navigateRoot(target && target.startsWith('/') && target !== '/login' ? target : '/home');
      void this.ui.toast(welcome, { icon: 'heart' });
    } catch (err) {
      const serverErrors = apiFieldErrors(err);
      const knownErrors: FieldErrors = {};
      for (const field of FOCUS_ORDER) {
        const message = serverErrors[field];
        if (message) knownErrors[field] = message;
      }
      if (Object.keys(knownErrors).length) {
        this.fieldErrors.set(knownErrors);
        this.markTouched(Object.keys(knownErrors) as FieldName[]);
        await this.focusFirstError(knownErrors);
      } else {
        this.error.set(apiErrorMessage(err));
      }
    } finally {
      this.submitting.set(false);
    }
  }

  browseAsGuest(): void {
    void this.router.navigateByUrl('/home');
  }

  private validateFields(fields: FieldName[]): FieldErrors {
    const errors: FieldErrors = {};
    for (const field of fields) {
      const message = this.validateField(field);
      if (message) errors[field] = message;
    }
    return errors;
  }

  private validateField(field: FieldName): string | null {
    if (this.mode() === 'login') {
      if (field === 'email') return this.email.trim() ? null : 'Enter your email.';
      if (field === 'password') return this.password ? null : 'Enter your password.';
      return null;
    }

    switch (field) {
      case 'firstName':
        return validateFirstName(this.firstName);
      case 'lastName':
        return validateLastName(this.lastName);
      case 'email':
        return validateEmail(this.email);
      case 'phone':
        return validatePhone(this.phone);
      case 'password':
        return validatePassword(this.password, {
          email: this.email,
          firstName: this.firstName,
          lastName: this.lastName,
        });
      case 'confirmPassword':
        return validateConfirmPassword(this.password, this.confirmPassword);
      case 'terms':
        return this.acceptedTerms ? null : 'Please agree to continue.';
    }
  }

  private revalidateIfVisible(field: FieldName): void {
    if (this.submitted() || this.isTouched(field) || !!this.fieldError(field)) {
      this.setFieldError(field, this.validateField(field));
    }
  }

  private setFieldError(field: FieldName, message: string | null): void {
    this.fieldErrors.update((current) => {
      const next = { ...current };
      if (message) next[field] = message;
      else delete next[field];
      return next;
    });
  }

  private markTouched(fields: FieldName[]): void {
    this.touched.update((current) => new Set([...current, ...fields]));
  }

  private async focusFirstError(errors: FieldErrors): Promise<void> {
    const field = FOCUS_ORDER.find((candidate) => !!errors[candidate]);
    if (!field) return;
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

    const element = document.getElementById(`${field}-field`);
    const reduceMotion = prefersReducedMotion();
    element?.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'center' });

    if (field === 'terms') {
      await this.termsInput()?.setFocus();
      return;
    }
    await this.inputFor(field)?.setFocus();
  }

  private inputFor(field: FieldName): IonInput | undefined {
    switch (field) {
      case 'firstName':
        return this.firstNameInput();
      case 'lastName':
        return this.lastNameInput();
      case 'email':
        return this.emailInput();
      case 'phone':
        return this.phoneInput();
      case 'password':
        return this.passwordInput();
      case 'confirmPassword':
        return this.confirmPasswordInput();
      case 'terms':
        return undefined;
    }
  }

  private async openConsent(): Promise<void> {
    if (this.consentOpening) return;
    this.consentOpening = true;
    try {
      const modal = await this.modals.create({
        component: ConsentModalComponent,
        cssClass: 'cf-consent-modal',
        breakpoints: [0, 1],
        initialBreakpoint: 1,
        handle: false,
        backdropDismiss: false,
      });
      await modal.present();
      const { role } = await modal.onDidDismiss();

      if (role === 'confirm') {
        this.consentUnlocked = true;
        this.acceptedTerms = true;
        if (this.termsInput()) this.termsInput()!.checked = true;
        this.updateTerms(true);
        return;
      }

      this.acceptedTerms = false;
      if (this.termsInput()) this.termsInput()!.checked = false;
      await this.termsInput()?.setFocus();
    } finally {
      this.consentOpening = false;
    }
  }
}
