/**
 * @file checkout.page.ts
 * @description Mobile checkout form, selected-cart review, reconciliation, and safe order submission.
 */
import { DecimalPipe } from '@angular/common';
import { Component, ViewChild, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { HttpErrorResponse } from '@angular/common/http';
import { Router, RouterLink } from '@angular/router';
import {
  IonBackButton,
  IonButton,
  IonButtons,
  IonCheckbox,
  IonContent,
  IonFooter,
  IonHeader,
  IonIcon,
  IonInput,
  ModalController,
  IonSpinner,
  IonTextarea,
  IonTitle,
  IonToolbar,
  CheckboxCustomEvent,
} from '@ionic/angular';
import { AuthService } from '../../core/auth.service';
import { AddressService } from '../../core/address.service';
import { CartService } from '../../core/cart.service';
import { CheckoutConfig, CLOSED_CHECKOUT_CONFIG, normalizeCheckoutConfig } from '../../core/checkout-config';
import { LocationPickerModalComponent } from '../../components/location-picker.modal';
import { DemoCardFormComponent } from '../../components/demo-card-form.component';
import { presentSimulatedCardVerification } from '../../components/simulated-card-verification.modal';
import { presentSimulatedWalletConfirmation } from '../../components/simulated-wallet-confirmation.modal';
import { DemoCardFlow, DemoCardScenario, demoScenarioForFlow } from '../../core/demo-card';
import { GeographicOption, GeographyService } from '../../core/geography.service';
import {
  CheckoutErrors,
  CheckoutField,
  CheckoutFormValue,
  CHECKOUT_STEPS,
  buildOrderDetails,
  canAutofillSavedAddress,
  canEditCheckoutStep,
  canStartOrderSubmission,
  cartSelectionSignature,
  checkoutStepAfter,
  checkoutPreview,
  isOnlinePayment,
  paymentLabel as paymentMethodLabel,
  prefillCheckout,
  applySavedAddress,
  selectedCartLines,
  selectCheckoutCity,
  validateCheckout,
  validateCheckoutField,
} from '../../core/checkout-rules';
import { apiErrorMessage, apiFieldErrors } from '../../core/api-error';
import { prefersReducedMotion } from '../../core/preference.service';
import { FulfillmentMethod, PaymentConfig, PaymentMethod, SavedAddress, thumbUrl } from '../../core/models';
import { isAmbiguousOrderError, OrderService, PendingCheckoutError } from '../../core/order.service';
import { ConsentModalComponent } from '../../components/consent-modal.component';

const EMPTY_FORM: CheckoutFormValue = {
  fulfillmentMethod: 'delivery',
  paymentMethod: 'cash_on_delivery',
  contactName: '',
  contactPhone: '',
  addressLine1: '',
  addressLine2: '',
  regionCode: '1300000000',
  region: 'National Capital Region (NCR)',
  barangayCode: '',
  barangay: '',
  cityCode: '',
  city: '',
  province: 'Metro Manila',
  postalCode: '',
  notes: '',
};

const FIELD_ORDER: CheckoutField[] = [
  'fulfillmentMethod',
  'paymentMethod',
  'contactName',
  'contactPhone',
  'addressLine1',
  'addressLine2',
  'cityCode',
  'barangayCode',
  'barangay',
  'city',
  'province',
  'postalCode',
  'notes',
];

export function isGenuineWalletMethod(config: PaymentConfig, method: PaymentMethod): boolean {
  return config.methods.some((entry) => entry.id === method
    && ['gcash', 'maya'].includes(entry.id)
    && entry.available
    && !entry.demo);
}

export function agreementAcceptedAfterReview(
  acceptedBeforeReview: boolean,
  role: string | undefined,
  preserveAcceptance: boolean,
): boolean {
  return role === 'confirm' || (preserveAcceptance && acceptedBeforeReview);
}

export function checkoutRefreshFailure(
  selectedLineCount: number,
  reviewedSignature: string,
  freshSignature: string,
): { reason: 'cart-unavailable' | 'cart-changed'; message: string } | null {
  if (!selectedLineCount) {
    return {
      reason: 'cart-unavailable',
      message: 'Your selected cart items are no longer available. Return to your cart and choose items again.',
    };
  }
  if (freshSignature !== reviewedSignature) {
    return {
      reason: 'cart-changed',
      message: 'Your cart changed, so we refreshed this review. Check the updated items and total before placing your order.',
    };
  }
  return null;
}

/** Starts a fresh manual delivery address while retaining customer-owned contact defaults. */
export function clearSavedAddressDraft(
  form: CheckoutFormValue,
  contact: Pick<CheckoutFormValue, 'contactName' | 'contactPhone'>,
): CheckoutFormValue {
  return {
    ...form,
    ...contact,
    addressLine1: '',
    addressLine2: '',
    cityCode: '',
    city: '',
    barangayCode: '',
    barangay: '',
    postalCode: '',
  };
}

export function shouldApplyDefaultAddress(
  prefillConsidered: boolean,
  addressDraftChanged: boolean,
  form: CheckoutFormValue,
  touched: ReadonlySet<CheckoutField>,
): boolean {
  return !prefillConsidered && !addressDraftChanged && canAutofillSavedAddress(form, touched);
}

export function shouldClearSavedAddressDraft(selectedAddressId: string | null, addressDraftChanged: boolean): boolean {
  return selectedAddressId !== null || !addressDraftChanged;
}

export function fulfillmentCapabilityError(
  config: CheckoutConfig,
  form: Pick<CheckoutFormValue, 'fulfillmentMethod' | 'cityCode'>,
): string | null {
  const method = form.fulfillmentMethod;
  if (!config[method].enabled) return config[method].unavailableMessage;
  if (method === 'delivery' && form.cityCode && !config.delivery.allowedCityCodes.includes(form.cityCode)) {
    return 'Delivery is unavailable for the selected city. Choose an approved delivery address.';
  }
  return null;
}

@Component({
  selector: 'app-checkout',
  templateUrl: 'checkout.page.html',
  styleUrls: ['checkout.page.scss'],
  imports: [
    DecimalPipe,
    FormsModule,
    RouterLink,
    IonHeader,
    IonToolbar,
    IonButtons,
    IonBackButton,
    IonTitle,
    IonContent,
    IonFooter,
    IonButton,
    IonCheckbox,
    IonIcon,
    IonInput,
    IonTextarea,
    IonSpinner,
    LocationPickerModalComponent,
    DemoCardFormComponent,
  ],
})
export class CheckoutPage {
  @ViewChild(DemoCardFormComponent) private demoCardForm?: DemoCardFormComponent;
  @ViewChild('agreementInput') private agreementInput?: IonCheckbox;

  readonly auth = inject(AuthService);
  readonly cartService = inject(CartService);
  readonly addressBook = inject(AddressService);
  readonly config = signal<CheckoutConfig>(CLOSED_CHECKOUT_CONFIG);
  readonly geography = inject(GeographyService);
  private orders = inject(OrderService);
  private router = inject(Router);
  private modals = inject(ModalController);

  readonly form = signal<CheckoutFormValue>({ ...EMPTY_FORM });
  readonly step = signal(0);
  readonly steps = CHECKOUT_STEPS;
  readonly errors = signal<CheckoutErrors>({});
  readonly touched = signal<ReadonlySet<CheckoutField>>(new Set());
  readonly loading = signal(true);
  readonly loadError = signal('');
  readonly submitting = signal(false);
  readonly pageMessage = signal('');
  readonly uncertain = signal(false);
  readonly completed = signal(false);
  readonly agreementEnabled = computed(() => this.config().agreement.required);
  readonly agreementAccepted = signal(false);
  readonly agreementTouched = signal(false);
  readonly locationPicker = signal<'city' | 'barangay' | null>(null);
  readonly addressLoading = signal(false);
  readonly addressError = signal('');
  readonly selectedAddressId = signal<string | null>(null);
  readonly paymentConfig = signal<PaymentConfig>({
    onlineEnabled: false,
    mode: 'disabled',
    publicKey: '',
    methods: [],
    unavailableMessage: 'Online payment is not configured for this class-project environment.',
  });
  readonly paymentConfigLoading = signal(true);
  readonly checkoutConfigLoading = signal(true);
  readonly demoCardFlow = signal<DemoCardFlow | null>(null);
  readonly selected = computed(() => selectedCartLines(this.cartService.cart()));
  readonly selectedLineCount = computed(() => this.selected().items.length + this.selected().boxes.length);
  readonly preview = computed(() => checkoutPreview(this.cartService.cart(), this.form().fulfillmentMethod));
  readonly thumb = thumbUrl;
  readonly paymentLabel = computed(() => paymentMethodLabel(this.form().paymentMethod));
  readonly onlinePayment = computed(() => isOnlinePayment(this.form().paymentMethod));
  readonly walletDemoSelected = computed(() => this.paymentConfig().methods.some(
    (entry) => entry.id === this.form().paymentMethod && entry.demoKind === 'wallet',
  ));
  readonly genuineWalletSelected = computed(() => isGenuineWalletMethod(
    this.paymentConfig(),
    this.form().paymentMethod,
  ));
  readonly deliveryCities = computed(() => {
    const allowed = new Set(this.config().delivery.allowedCityCodes);
    return (this.geography.data()?.cities ?? []).filter((city) => allowed.has(city.code));
  });

  private profileFilled = false;
  private reviewedSignature = '';
  private locationTrigger: HTMLElement | null = null;
  private agreementUnlocked = false;
  private agreementOpening = false;
  private addressPrefillConsidered = false;
  private addressDraftChanged = false;
  private manualContactName: string | null = null;
  private manualContactPhone: string | null = null;

  async ionViewWillEnter(): Promise<void> {
    if (this.completed()) {
      this.completed.set(false);
      this.agreementAccepted.set(false);
      this.agreementTouched.set(false);
      this.agreementUnlocked = false;
    }
    if (!this.auth.isLoggedIn()) {
      await this.router.navigate(['/login'], { queryParams: { returnUrl: '/checkout' }, replaceUrl: true });
      return;
    }
    this.prefillProfile();
    this.uncertain.set(!!this.orders.pendingAttempt());
    void this.geography.load();
    void this.loadSavedAddresses();
    void this.loadPaymentConfig();
    void this.loadCheckoutConfig();
    await this.loadReview();
  }

  async loadSavedAddresses(): Promise<void> {
    this.addressLoading.set(true);
    this.addressError.set('');
    try {
      const addresses = await this.addressBook.load();
      const defaultAddress = addresses.find((address) => address.isDefault);
      if (defaultAddress && shouldApplyDefaultAddress(
        this.addressPrefillConsidered,
        this.addressDraftChanged,
        this.form(),
        this.touched(),
      )) {
        this.useSavedAddress(defaultAddress);
      }
      this.addressPrefillConsidered = true;
    } catch {
      this.addressError.set('Saved addresses could not load. You can still enter an address below.');
    } finally {
      this.addressLoading.set(false);
    }
  }

  useSavedAddress(address: SavedAddress): void {
    this.form.update((current) => applySavedAddress(current, address));
    this.selectedAddressId.set(address.id);
    this.errors.update((current) => ({
      ...current,
      contactName: undefined,
      contactPhone: undefined,
      addressLine1: undefined,
      addressLine2: undefined,
      cityCode: undefined,
      city: undefined,
      barangayCode: undefined,
      barangay: undefined,
      postalCode: undefined,
    }));
  }

  useManualAddress(): void {
    if (!shouldClearSavedAddressDraft(this.selectedAddressId(), this.addressDraftChanged)) return;
    this.addressDraftChanged = true;
    this.addressPrefillConsidered = true;
    this.selectedAddressId.set(null);
    const user = this.auth.user();
    this.form.update((current) => clearSavedAddressDraft(current, {
      contactName: this.manualContactName ?? user?.fullName ?? '',
      contactPhone: this.manualContactPhone ?? user?.phone ?? '',
    }));
    const addressFields = new Set<CheckoutField>([
      'addressLine1', 'addressLine2', 'cityCode', 'city', 'barangayCode', 'barangay', 'postalCode',
    ]);
    this.errors.update((current) => Object.fromEntries(
      Object.entries(current).filter(([field]) => !addressFields.has(field as CheckoutField)),
    ) as CheckoutErrors);
    this.touched.update((current) => new Set([...current].filter((field) => !addressFields.has(field))));
  }

  async loadReview(): Promise<void> {
    this.loading.set(true);
    this.loadError.set('');
    try {
      await this.cartService.load();
      this.reviewedSignature = cartSelectionSignature(this.cartService.cart());
    } catch (error) {
      this.loadError.set(apiErrorMessage(error));
    } finally {
      this.loading.set(false);
    }
  }

  chooseFulfillment(method: FulfillmentMethod): void {
    if (!this.config()[method].enabled || this.submitting()) return;
    this.form.update((value) => ({
      ...value,
      fulfillmentMethod: method,
      paymentMethod: isOnlinePayment(value.paymentMethod)
        ? value.paymentMethod
        : method === 'pickup' ? 'cash_on_pickup' : 'cash_on_delivery',
    }));
    this.errors.update((value) => ({ ...value, fulfillmentMethod: undefined, fulfillment: undefined }));
    if (method === 'delivery') void this.geography.load();
  }

  choosePayment(method: PaymentMethod): void {
    if (!this.paymentAvailable(method) || this.submitting()) return;
    if (method !== 'card') {
      this.demoCardForm?.clear();
      this.demoCardFlow.set(null);
    }
    this.form.update((current) => ({ ...current, paymentMethod: method }));
    this.errors.update((current) => ({ ...current, paymentMethod: undefined }));
  }

  paymentAvailable(method: PaymentMethod): boolean {
    if (method === 'cash_on_delivery') return this.form().fulfillmentMethod === 'delivery';
    if (method === 'cash_on_pickup') return this.form().fulfillmentMethod === 'pickup';
    return this.paymentConfig().onlineEnabled
      && this.paymentConfig().methods.some((entry) => entry.id === method && entry.available);
  }

  private async loadPaymentConfig(): Promise<void> {
    this.paymentConfigLoading.set(true);
    try {
      this.paymentConfig.set(await this.orders.paymentConfig());
    } catch {
      this.paymentConfig.update((current) => ({ ...current, onlineEnabled: false }));
    } finally {
      this.paymentConfigLoading.set(false);
    }
  }

  private async loadCheckoutConfig(): Promise<void> {
    this.checkoutConfigLoading.set(true);
    try {
      const previousVersion = this.config().agreement.version;
      const config = normalizeCheckoutConfig(await this.orders.checkoutConfig());
      this.config.set(config);
      if (previousVersion && previousVersion !== config.agreement.version) {
        this.agreementAccepted.set(false);
        this.agreementTouched.set(false);
      }
      const selectedMethod = this.form().fulfillmentMethod;
      if (!config[selectedMethod].enabled) {
        const replacement = config.delivery.enabled ? 'delivery' : config.pickup.enabled ? 'pickup' : null;
        if (replacement) this.chooseFulfillment(replacement);
      }
    } catch {
      this.config.set(CLOSED_CHECKOUT_CONFIG);
    } finally {
      this.checkoutConfigLoading.set(false);
    }
  }

  openLocationPicker(kind: 'city' | 'barangay', event?: Event): void {
    if (kind === 'barangay' && !this.form().cityCode) return;
    this.locationTrigger = event?.currentTarget as HTMLElement | null;
    this.locationPicker.set(kind);
  }

  closeLocationPicker(): void {
    const trigger = this.locationTrigger;
    this.locationPicker.set(null);
    this.locationTrigger = null;
    setTimeout(() => trigger?.focus());
  }

  chooseCity(city: GeographicOption): void {
    this.addressDraftChanged = true;
    this.selectedAddressId.set(null);
    this.form.update((current) => selectCheckoutCity(current, city));
    this.errors.update((current) => ({
      ...current,
      cityCode: undefined,
      city: undefined,
      barangayCode: undefined,
      barangay: undefined,
    }));
    this.closeLocationPicker();
  }

  chooseBarangay(barangay: GeographicOption): void {
    this.addressDraftChanged = true;
    this.selectedAddressId.set(null);
    this.form.update((current) => ({ ...current, barangayCode: barangay.code, barangay: barangay.name }));
    this.errors.update((current) => ({ ...current, barangayCode: undefined, barangay: undefined }));
    this.closeLocationPicker();
  }

  locationError(kind: 'city' | 'barangay'): string | undefined {
    return kind === 'city'
      ? this.errors().cityCode ?? this.errors().city
      : this.errors().barangayCode ?? this.errors().barangay;
  }

  update(field: CheckoutField, value: unknown): void {
    if (['contactName', 'contactPhone', 'addressLine1', 'addressLine2', 'postalCode'].includes(field)) {
      this.addressDraftChanged = true;
      this.selectedAddressId.set(null);
    }
    if (field === 'contactName') this.manualContactName = String(value ?? '');
    if (field === 'contactPhone') this.manualContactPhone = String(value ?? '');
    this.form.update((current) => ({ ...current, [field]: String(value ?? '') }));
    if (this.touched().has(field) || this.errors()[field]) {
      this.errors.update((current) => ({ ...current, [field]: validateCheckoutField(field, this.form()) ?? undefined }));
    }
  }

  blur(field: CheckoutField): void {
    this.touched.update((current) => new Set(current).add(field));
    this.errors.update((current) => ({ ...current, [field]: validateCheckoutField(field, this.form()) ?? undefined }));
  }

  fieldError(field: CheckoutField): string | undefined {
    return this.errors()[field];
  }

  isTouched(field: CheckoutField): boolean {
    return this.touched().has(field);
  }

  onAgreementChange(event: CheckboxCustomEvent): void {
    this.agreementTouched.set(true);
    if (!event.detail.checked) {
      this.agreementUnlocked = false;
      this.agreementAccepted.set(false);
      return;
    }
    if (this.agreementUnlocked) {
      this.agreementAccepted.set(true);
      this.agreementUnlocked = false;
      return;
    }
    event.target.checked = false;
    this.agreementAccepted.set(false);
    void this.openOrderAgreement(false);
  }

  async openOrderAgreement(preserveAcceptance = true): Promise<void> {
    if (this.agreementOpening) return;
    this.agreementOpening = true;
    const acceptedBeforeReview = this.agreementAccepted();
    try {
      const modal = await this.modals.create({
        component: ConsentModalComponent,
        componentProps: {
          title: 'Review order policies',
          confirmLabel: 'Agree and Continue',
          cancelLabel: acceptedBeforeReview ? 'Close policy review' : 'Decline and close',
          agreementVersion: this.config().agreement.version ?? '',
        },
        cssClass: 'cf-consent-modal',
        breakpoints: [0, 1],
        initialBreakpoint: 1,
        handle: false,
        backdropDismiss: false,
      });
      await modal.present();
      const { role } = await modal.onDidDismiss();
      const accepted = agreementAcceptedAfterReview(acceptedBeforeReview, role, preserveAcceptance);
      if (role === 'confirm') {
        this.agreementUnlocked = true;
      }
      this.agreementAccepted.set(accepted);
      if (this.agreementInput) this.agreementInput.checked = accepted;
      this.agreementTouched.set(true);
      await this.agreementInput?.setFocus();
    } finally {
      this.agreementOpening = false;
    }
  }

  boxSummary(names: string[]): string {
    const counts = new Map<string, number>();
    for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
    return [...counts].map(([name, count]) => count > 1 ? `${count}× ${name}` : name).join(', ');
  }

  boxCookieNames(box: { cookies: { name: string }[] }): string[] {
    return box.cookies.map((cookie) => cookie.name);
  }

  async nextStep(): Promise<void> {
    if (this.step() === 0) {
      const errors = validateCheckout(this.form());
      delete errors.notes;
      const capabilityError = fulfillmentCapabilityError(this.config(), this.form());
      if (capabilityError) errors.fulfillment = capabilityError;
      if (Object.keys(errors).length) {
        this.errors.set(errors);
        this.touched.set(new Set(FIELD_ORDER));
        await this.focusFirstError(errors);
        return;
      }
    }
    if (this.step() === 2 && !this.paymentAvailable(this.form().paymentMethod)) {
      const errors = { paymentMethod: 'Choose an available payment method.' };
      this.errors.set(errors);
      this.touched.update((current) => new Set(current).add('paymentMethod'));
      await this.focusFirstError(errors);
      return;
    }
    if (this.step() === 2 && this.form().paymentMethod === 'card') {
      const flow = this.demoCardForm?.validate() ?? null;
      if (!flow) return;
      this.demoCardFlow.set(flow);
    }
    this.setStep(checkoutStepAfter(this.step(), 'next'));
  }

  previousStep(): void {
    this.setStep(checkoutStepAfter(this.step(), 'back'));
  }

  editStep(index: number): void {
    if (!canEditCheckoutStep(this.step(), index)) return;
    if (index === 2 && this.form().paymentMethod === 'card') this.demoCardFlow.set(null);
    this.setStep(index);
  }

  private setStep(index: number): void {
    this.step.set(index);
    this.pageMessage.set('');
    setTimeout(() => document.getElementById('checkout-top')?.scrollIntoView({ block: 'start' }));
  }

  async submit(): Promise<void> {
    if (!canStartOrderSubmission(this.step(), this.submitting(), this.completed())) return;
    this.pageMessage.set('');
    if (this.agreementEnabled() && !this.agreementAccepted()) {
      this.agreementTouched.set(true);
      await new Promise((resolve) => setTimeout(resolve));
      const agreement = document.getElementById('checkout-agreement');
      agreement?.scrollIntoView({
        behavior: prefersReducedMotion() ? 'auto' : 'smooth',
        block: 'center',
      });
      (agreement as HTMLElement & { setFocus?: () => Promise<void> } | null)?.setFocus?.();
      return;
    }
    if (this.form().paymentMethod === 'card' && !this.demoCardFlow()) {
      this.step.set(2);
      this.pageMessage.set('Enter a supported synthetic test card before continuing.');
      return;
    }
    const errors = validateCheckout(this.form());
    const capabilityError = fulfillmentCapabilityError(this.config(), this.form());
    if (capabilityError) errors.fulfillment = capabilityError;
    if (Object.keys(errors).length) {
      this.errors.set(errors);
      this.touched.set(new Set(FIELD_ORDER));
      if (Object.keys(errors).some((field) => field !== 'notes')) this.step.set(0);
      await this.focusFirstError(errors);
      return;
    }

    const popupExpected = this.genuineWalletSelected() && this.orders.supportsDesktopPaymentPopup();
    const paymentPopup = popupExpected ? this.orders.openPaymentPopup() : null;
    this.submitting.set(true);
    try {
      const beforeRefresh = this.reviewedSignature;
      await this.cartService.load();
      const freshSignature = cartSelectionSignature(this.cartService.cart());
      this.reviewedSignature = freshSignature;
      const refreshFailure = checkoutRefreshFailure(this.selectedLineCount(), beforeRefresh, freshSignature);
      if (refreshFailure) {
        this.orders.failPaymentPopup(paymentPopup, refreshFailure.reason);
        this.pageMessage.set(refreshFailure.message);
        return;
      }

      const agreementVersion = this.config().agreement.version;
      const agreement = this.agreementEnabled() && agreementVersion
        ? { accepted: true as const, version: agreementVersion }
        : undefined;
      const order = await this.orders.place(buildOrderDetails(this.form(), agreement), freshSignature);
      this.completed.set(true);
      await this.cartService.load().catch(() => undefined);
      if (order.paymentMethod === 'card') {
        const scenario = await this.resolveDemoScenario();
        if (!scenario) {
          await this.router.navigate(['/order', order.id], {
            queryParams: { demo: 'retry' },
            replaceUrl: true,
          });
          return;
        }
        try {
          await this.orders.submitDemoCard(order.id, scenario);
          this.demoCardForm?.clear();
          await this.router.navigate(['/order', order.id], { replaceUrl: true });
        } catch {
          await this.router.navigate(['/order', order.id], {
            queryParams: { demo: 'retry' },
            replaceUrl: true,
          });
        }
      } else if (order.paymentIsDemo && ['gcash', 'maya'].includes(order.paymentMethod)) {
        const action = await presentSimulatedWalletConfirmation(this.modals, {
          walletLabel: paymentMethodLabel(order.paymentMethod),
          orderReference: order.id.split('-')[0].toUpperCase(),
          amount: order.total,
        });
        if (action) {
          await this.orders.submitDemoWallet(order.id, action).catch(() => undefined);
        }
        await this.router.navigate(['/order', order.id], { replaceUrl: true });
      } else if (isOnlinePayment(order.paymentMethod)) {
        if (popupExpected) {
          const opened = paymentPopup && this.orders.navigatePaymentPopup(paymentPopup, order.id);
          await this.router.navigate(['/order', order.id], {
            queryParams: { payment: opened ? 'popup-open' : 'popup-blocked' },
            replaceUrl: true,
          });
        } else {
          try {
            await this.orders.startIntegratedPayment(order, this.paymentConfig());
          } catch {
            await this.router.navigate(['/order', order.id], {
              queryParams: { payment: 'retry' },
              replaceUrl: true,
            });
          }
        }
      } else {
        this.orders.closePaymentPopup(paymentPopup);
        await this.router.navigate(['/order', order.id], { replaceUrl: true });
      }
    } catch (error) {
      this.orders.failPaymentPopup(paymentPopup, 'order-failed');
      await this.handleSubmitError(error);
    } finally {
      this.submitting.set(false);
    }
  }

  private async resolveDemoScenario(): Promise<DemoCardScenario | null> {
    const flow = this.demoCardFlow();
    if (!flow) return null;
    if (flow !== 'three_ds') return demoScenarioForFlow(flow);
    const approved = await presentSimulatedCardVerification(this.modals);
    return approved === null ? null : demoScenarioForFlow(flow, approved);
  }

  async retryOriginal(): Promise<void> {
    if (this.submitting() || this.completed()) return;
    this.submitting.set(true);
    this.pageMessage.set('');
    try {
      await this.cartService.load();
      const signature = cartSelectionSignature(this.cartService.cart());
      const order = await this.orders.retryPending(signature, this.cartService.cart().selectedCount === 0);
      this.completed.set(true);
      await this.cartService.load().catch(() => undefined);
      await this.router.navigate(['/order', order.id], { replaceUrl: true });
    } catch (error) {
      await this.handleSubmitError(error);
    } finally {
      this.submitting.set(false);
    }
  }

  private prefillProfile(): void {
    if (this.profileFilled) return;
    const user = this.auth.user();
    if (!user) return;
    this.form.update((value) => prefillCheckout(value, user));
    this.profileFilled = true;
  }

  private async handleSubmitError(error: unknown): Promise<void> {
    if (error instanceof PendingCheckoutError) {
      this.uncertain.set(true);
      this.pageMessage.set(error.message);
      return;
    }
    if (isAmbiguousOrderError(error)) {
      this.uncertain.set(true);
      this.pageMessage.set('We could not confirm whether your order was placed. Retry the original order to recover it safely.');
      return;
    }

    const fieldErrors = apiFieldErrors(error) as CheckoutErrors;
    if (Object.keys(fieldErrors).length) {
      this.errors.update((current) => ({ ...current, ...fieldErrors }));
      await this.focusFirstError(fieldErrors);
    }
    this.pageMessage.set(apiErrorMessage(error));
    if (error instanceof HttpErrorResponse && error.status === 409) {
      await this.loadReview();
    }
  }

  private async focusFirstError(errors: CheckoutErrors): Promise<void> {
    const invalidField = FIELD_ORDER.find((candidate) => errors[candidate]);
    const field = invalidField === 'city' ? 'cityCode' : invalidField === 'barangay' ? 'barangayCode' : invalidField;
    if (!field) return;
    await new Promise((resolve) => setTimeout(resolve));
    const element = document.getElementById(`checkout-${field}`) as (HTMLElement & { setFocus?: () => Promise<void> }) | null;
    const behavior = prefersReducedMotion() ? 'auto' : 'smooth';
    element?.scrollIntoView({ behavior, block: 'center' });
    if (element?.setFocus) await element.setFocus();
    else element?.focus();
  }
}
