/**
 * @file login.page.ts
 * @description Accessible login and signup flow with inline validation.
 */
import { AfterViewInit, Component, ElementRef, inject, input, OnDestroy, signal, viewChild } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
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
import { AuthService, GoogleAuthConfig, GoogleAuthIntent, GoogleAuthPending } from '../../core/auth.service';
import { GoogleAuthService } from '../../core/google-auth.service';
import { UiService } from '../../core/ui.service';
import { apiErrorMessage, apiFieldErrors } from '../../core/api-error';
import {
  validateEmail,
  validateConfirmPassword,
  validateFirstName,
  validateLastName,
  validatePassword,
  validatePhone,
} from '../../core/signup-rules';
import { ConsentModalComponent } from '../../components/consent-modal.component';
import { prefersReducedMotion } from '../../core/preference.service';
import { PasswordRequirementsComponent } from '../../components/password-requirements.component';

type Mode = 'login' | 'signup';
type FieldName = 'firstName' | 'lastName' | 'email' | 'phone' | 'password' | 'confirmPassword' | 'terms';
type TextField = Exclude<FieldName, 'terms'>;
const GOOGLE_LINK_RESTART_CODE = 'google_link_restart_required';
const GOOGLE_LINK_RESTART_MESSAGE = "We couldn't confirm your Cookie Fluffs password. Select Continue with Google to try again.";
const GOOGLE_RETRY_MESSAGE = 'Google sign-in was interrupted. Select Continue with Google to try again.';

/** A friendly notice shown when the Google account does not match the chosen tab. */
interface GoogleNotice {
  kind: 'signup_needed' | 'login_required';
  message: string;
}
type FieldErrors = Partial<Record<FieldName, string>>;
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
    PasswordRequirementsComponent,
  ],
})
export class LoginPage implements AfterViewInit, OnDestroy {
  /** Where to go after logging in (query param ?returnUrl=/cart). */
  readonly returnUrl = input<string>();

  private auth = inject(AuthService);
  private ui = inject(UiService);
  private nav = inject(NavController);
  private router = inject(Router);
  private route = inject(ActivatedRoute);
  private modals = inject(ModalController);
  private google = inject(GoogleAuthService);

  private readonly firstNameInput = viewChild<IonInput>('firstNameInput');
  private readonly lastNameInput = viewChild<IonInput>('lastNameInput');
  private readonly emailInput = viewChild<IonInput>('emailInput');
  private readonly phoneInput = viewChild<IonInput>('phoneInput');
  private readonly passwordInput = viewChild<IonInput>('passwordInput');
  private readonly confirmPasswordInput = viewChild<IonInput>('confirmPasswordInput');
  private readonly termsInput = viewChild<IonCheckbox>('termsInput');
  private readonly googleButton = viewChild<ElementRef<HTMLElement>>('googleButton');

  readonly mode = signal<Mode>('login');
  readonly submitting = signal(false);
  readonly error = signal<string | null>(null);
  readonly fieldErrors = signal<FieldErrors>({});
  readonly touched = signal<ReadonlySet<FieldName>>(new Set());
  readonly submitted = signal(false);
  readonly googleEnabled = signal(false);
  readonly googleBusy = signal(false);
  readonly googleError = signal<string | null>(null);
  readonly googlePending = signal<GoogleAuthPending | null>(null);
  readonly googleNotice = signal<GoogleNotice | null>(null);
  readonly nativeGoogle = this.google.isNativeAndroid;
  private googleConfig: GoogleAuthConfig | null = null;

  email = '';
  password = '';
  firstName = '';
  lastName = '';
  phone = '';
  confirmPassword = '';
  acceptedTerms = false;
  private consentUnlocked = false;
  private consentOpening = false;

  ngAfterViewInit(): void {
    // Restore the selected tab from the validated query param so a GIS reload that
    // was triggered to switch intent reopens the correct tab. Only 'signup' is
    // honoured; any other value safely falls back to the default login tab.
    if (this.route.snapshot.queryParamMap.get('mode') === 'signup') this.mode.set('signup');
    this.google.prepareWebPage();
    const restartNotice = this.google.consumeRestartNotice();
    if (restartNotice) {
      this.googleError.set(restartNotice === 'link' ? GOOGLE_LINK_RESTART_MESSAGE : GOOGLE_RETRY_MESSAGE);
    }
    void this.prepareGoogle();
  }

  ngOnDestroy(): void {
    this.google.restoreWebPage();
  }

  setMode(value: unknown): void {
    if ((value === 'login' || value === 'signup') && value !== this.mode()) {
      this.mode.set(value);
      this.error.set(null);
      this.fieldErrors.set({});
      this.touched.set(new Set());
      this.submitted.set(false);
      this.startFreshGoogleAttempt();
    }
  }

  /**
   * Switching tabs must start a fresh Google attempt bound to the new intent.
   * On web GIS initializes once per document, so if an attempt already began we
   * reload to issue a new nonce; otherwise we re-prime the button in place.
   */
  private startFreshGoogleAttempt(): void {
    this.googleNotice.set(null);
    this.googleError.set(null);
    this.googlePending.set(null);
    if (!this.googleEnabled()) return;
    if (!this.nativeGoogle && this.google.hasInitializedWebAttempt()) {
      // A fresh web attempt needs a page reload to re-init GIS with a new nonce.
      // Persist the selected tab in the URL first so the reload reopens it.
      this.syncModeQueryParam();
      this.google.restartWebPage(null);
      return;
    }
    void this.prepareWebGoogleButton();
  }

  /**
   * Writes the current tab into the ?mode= query param without navigating, so a
   * following GIS reload preserves it. Never carries tokens, nonces, or selectors.
   */
  private syncModeQueryParam(): void {
    const tree = this.router.createUrlTree([], {
      queryParams: { mode: this.mode() },
      queryParamsHandling: 'merge',
    });
    history.replaceState(history.state, document.title, this.router.serializeUrl(tree));
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
      await this.nav.navigateRoot(
      this.auth.isSuperAdmin() ? '/admin' : target && target.startsWith('/') && target !== '/login' ? target : '/home',
    );
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

  async startNativeGoogle(): Promise<void> {
    if (!this.googleConfig?.enabled || !this.googleConfig.webClientId || this.googleBusy()) return;
    this.googleBusy.set(true);
    this.googleError.set(null);
    try {
      const issued = await this.auth.googleNonce(this.mode() as GoogleAuthIntent);
      const idToken = await this.google.nativeIdToken(this.googleConfig.webClientId, issued.nonce);
      this.googleBusy.set(false);
      await this.finishGoogle(idToken, issued.selector, issued.nonce);
    } catch (error) {
      this.captureGoogleFailure(error);
    } finally {
      this.googleBusy.set(false);
    }
  }

  async completeGoogleSignup(): Promise<void> {
    const pending = this.googlePending();
    if (pending?.kind !== 'signup_required' || this.googleBusy()) return;
    const nameError = validateFirstName(this.firstName)
      || validateLastName(this.lastName)
      || validatePhone(this.phone);
    if (nameError) {
      this.googleError.set(nameError);
      return;
    }
    if (!this.acceptedTerms) {
      await this.openConsent();
      if (!this.acceptedTerms) return;
    }
    this.googleBusy.set(true);
    this.googleError.set(null);
    try {
      const user = await this.auth.completeGoogleSignup(
        pending.selector,
        pending.challenge,
        this.firstName,
        this.lastName,
        this.phone,
        this.acceptedTerms,
      );
      await this.completeGoogleNavigation(user.firstName ?? user.fullName.split(' ')[0]);
    } catch (error) {
      this.captureGoogleFailure(error);
    } finally {
      this.googleBusy.set(false);
    }
  }

  async completeGoogleLink(): Promise<void> {
    const pending = this.googlePending();
    if (pending?.kind !== 'link_required' || !this.password || this.googleBusy()) return;
    this.googleBusy.set(true);
    this.googleError.set(null);
    try {
      const user = await this.auth.linkGoogleAccount(pending.selector, pending.challenge, this.password);
      this.password = '';
      await this.completeGoogleNavigation(user.firstName ?? user.fullName.split(' ')[0]);
    } catch (error) {
      if (error instanceof HttpErrorResponse
        && error.status === 400
        && error.error?.code === GOOGLE_LINK_RESTART_CODE) {
        this.googlePending.set(null);
        this.password = '';
        if (this.nativeGoogle) this.googleError.set(GOOGLE_LINK_RESTART_MESSAGE);
        else this.google.restartWebPage('link');
      } else {
        this.captureGoogleFailure(error);
      }
    } finally {
      this.googleBusy.set(false);
    }
  }

  /** Notice action: move to the Sign Up tab and begin a fresh signup-intent attempt. */
  goToSignupFromNotice(): void {
    this.setMode('signup');
  }

  /** Notice action: move to the Login tab and begin a fresh login-intent attempt. */
  goToLoginFromNotice(): void {
    this.setMode('login');
  }

  /** Notice action: try a different Google account under the current tab's intent. */
  useAnotherGoogleAccount(): void {
    this.startFreshGoogleAttempt();
  }

  cancelGoogleCompletion(): void {
    if (!this.nativeGoogle) {
      this.google.restartWebPage(null);
      return;
    }
    this.googlePending.set(null);
    this.googleError.set(null);
    this.password = '';
    this.acceptedTerms = false;
    void this.prepareWebGoogleButton();
  }

  private async prepareGoogle(): Promise<void> {
    if (!this.nativeGoogle && this.google.hasInitializedWebAttempt()) {
      this.google.restartWebPage(null);
      return;
    }
    try {
      this.googleConfig = await this.auth.googleAuthConfig();
      this.googleEnabled.set(this.googleConfig.enabled && !!this.googleConfig.webClientId);
      await this.prepareWebGoogleButton();
    } catch {
      this.googleEnabled.set(false);
    }
  }

  private async prepareWebGoogleButton(): Promise<void> {
    if (!this.googleEnabled() || this.nativeGoogle || this.googlePending() || this.googleNotice()
      || !this.googleConfig?.webClientId) return;
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const element = this.googleButton()?.nativeElement;
    if (!element) return;
    try {
      const issued = await this.auth.googleNonce(this.mode() as GoogleAuthIntent);
      await this.google.renderWebButton(element, this.googleConfig.webClientId, issued.nonce, (idToken) => {
        void this.finishGoogle(idToken, issued.selector, issued.nonce);
      });
    } catch (error) {
      this.captureGoogleFailure(error);
    }
  }

  private async finishGoogle(idToken: string, selector: string, nonce: string): Promise<void> {
    if (this.googleBusy()) return;
    this.googleBusy.set(true);
    this.googleError.set(null);
    try {
      const user = await this.auth.authenticateWithGoogle(idToken, selector, nonce);
      await this.completeGoogleNavigation(user.firstName ?? user.fullName.split(' ')[0]);
    } catch (error) {
      if (error instanceof HttpErrorResponse
        && (error.error?.kind === 'signup_required' || error.error?.kind === 'link_required')) {
        this.googlePending.set(error.error as GoogleAuthPending);
        if (error.error.profile) {
          this.firstName = error.error.profile.firstName;
          this.lastName = error.error.profile.lastName;
          this.email = error.error.profile.email;
        }
        return;
      }
      if (error instanceof HttpErrorResponse
        && (error.error?.kind === 'signup_needed' || error.error?.kind === 'login_required')) {
        // Intent mismatch: show friendly guidance with a clear next action instead
        // of silently creating or authenticating an account.
        this.googleNotice.set({ kind: error.error.kind, message: error.error.message });
        return;
      }
      this.captureGoogleFailure(error);
      if (!this.nativeGoogle) this.google.restartWebPage('retry');
    } finally {
      this.googleBusy.set(false);
    }
  }

  private captureGoogleFailure(error: unknown): void {
    const message = apiErrorMessage(error);
    this.googleError.set(message === 'Something went wrong on our side. Please try again.'
      ? 'Google sign-in could not be completed. Please try again.'
      : message);
  }

  private async completeGoogleNavigation(firstName: string): Promise<void> {
    const target = this.returnUrl();
    await this.nav.navigateRoot(
      this.auth.isSuperAdmin() ? '/admin' : target && target.startsWith('/') && target !== '/login' ? target : '/home',
    );
    void this.ui.toast(`Welcome, ${firstName}!`, { icon: 'heart' });
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
