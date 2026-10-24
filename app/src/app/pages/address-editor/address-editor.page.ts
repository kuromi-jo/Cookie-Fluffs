/**
 * @file address-editor.page.ts
 * @description Add and edit one authenticated customer's NCR delivery address.
 */
import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import {
  IonBackButton,
  IonButton,
  IonButtons,
  IonCheckbox,
  IonContent,
  IonHeader,
  IonIcon,
  IonInput,
  IonSpinner,
  IonTitle,
  IonToolbar,
} from '@ionic/angular';
import { LocationPickerModalComponent } from '../../components/location-picker.modal';
import { AddressService } from '../../core/address.service';
import { apiErrorMessage, apiFieldErrors } from '../../core/api-error';
import { AuthService } from '../../core/auth.service';
import { GeographicOption, GeographyService } from '../../core/geography.service';
import { SavedAddressInput } from '../../core/models';
import { normalizePhone } from '../../core/signup-rules';
import { UiService } from '../../core/ui.service';

type AddressField = keyof SavedAddressInput;
type AddressErrors = Partial<Record<AddressField, string>>;

export interface AddressDraft extends SavedAddressInput { makeDefault: boolean; }

export const EMPTY_ADDRESS: AddressDraft = {
  label: 'Home', recipientName: '', recipientPhone: '', addressLine1: '', addressLine2: '',
  cityCode: '', barangayCode: '', postalCode: '', makeDefault: false,
};

function bounded(value: string, label: string, min: number, max: number): string | null {
  const text = value.trim().replace(/\s+/g, ' ');
  return text.length < min || text.length > max || /[\u0000-\u001f\u007f]/.test(text)
    ? `${label} must be ${min} to ${max} characters.` : null;
}

export function validateAddressDraft(draft: AddressDraft): AddressErrors {
  const errors: AddressErrors = {};
  errors.label = bounded(draft.label, 'Address label', 1, 30) ?? undefined;
  errors.recipientName = bounded(draft.recipientName, 'Recipient name', 2, 80) ?? undefined;
  errors.recipientPhone = normalizePhone(draft.recipientPhone) ? undefined : 'Enter a Philippine mobile number, like 0917 123 4567.';
  errors.addressLine1 = bounded(draft.addressLine1, 'Street address', 5, 120) ?? undefined;
  errors.addressLine2 = bounded(draft.addressLine2, 'Unit or landmark', 0, 120) ?? undefined;
  errors.cityCode = /^\d{10}$/.test(draft.cityCode) ? undefined : 'Choose an NCR city or municipality.';
  errors.barangayCode = /^\d{10}$/.test(draft.barangayCode) ? undefined : 'Choose a barangay.';
  errors.postalCode = /^\d{4}$/.test(draft.postalCode.trim()) ? undefined : 'Enter a 4-digit Philippine postal code.';
  return Object.fromEntries(Object.entries(errors).filter(([, message]) => message));
}

@Component({
  selector: 'app-address-editor',
  templateUrl: 'address-editor.page.html',
  styleUrls: ['address-editor.page.scss'],
  imports: [FormsModule, LocationPickerModalComponent, IonHeader, IonToolbar, IonButtons, IonBackButton, IonTitle, IonContent, IonButton, IonCheckbox, IonIcon, IonInput, IonSpinner],
})
export class AddressEditorPage {
  readonly geography = inject(GeographyService);
  private addressBook = inject(AddressService);
  private auth = inject(AuthService);
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private ui = inject(UiService);

  readonly draft = signal<AddressDraft>({ ...EMPTY_ADDRESS });
  readonly errors = signal<AddressErrors>({});
  readonly touched = signal<ReadonlySet<AddressField>>(new Set());
  readonly loading = signal(false);
  readonly saving = signal(false);
  readonly pageError = signal('');
  readonly picker = signal<'city' | 'barangay' | null>(null);
  readonly editId = signal('');
  private pickerTrigger: HTMLElement | null = null;

  async ionViewWillEnter(): Promise<void> {
    if (!this.auth.isLoggedIn()) {
      await this.router.navigate(['/login'], { queryParams: { returnUrl: this.router.url }, replaceUrl: true });
      return;
    }
    void this.geography.load();
    const id = this.route.snapshot.paramMap.get('id') ?? '';
    this.editId.set(id);
    if (!id) {
      this.draft.set({ ...EMPTY_ADDRESS });
      return;
    }
    this.loading.set(true);
    try {
      const addresses = await this.addressBook.load();
      const address = addresses.find((entry) => entry.id === id);
      if (!address) throw new Error('Address not found.');
      this.draft.set({
        label: address.label, recipientName: address.recipientName, recipientPhone: address.recipientPhone,
        addressLine1: address.addressLine1, addressLine2: address.addressLine2, cityCode: address.cityCode,
        barangayCode: address.barangayCode, postalCode: address.postalCode, makeDefault: address.isDefault,
      });
    } catch (error) {
      this.pageError.set(apiErrorMessage(error));
    } finally {
      this.loading.set(false);
    }
  }

  update(field: AddressField, value: unknown): void {
    this.draft.update((current) => ({ ...current, [field]: String(value ?? '') }));
    this.pageError.set('');
    if (this.touched().has(field) || this.errors()[field]) this.validateField(field);
  }

  useLabel(label: 'Home' | 'Work'): void { this.update('label', label); }
  blur(field: AddressField): void { this.touched.update((value) => new Set(value).add(field)); this.validateField(field); }
  fieldError(field: AddressField): string | undefined { return this.errors()[field]; }
  isTouched(field: AddressField): boolean { return this.touched().has(field); }

  openPicker(kind: 'city' | 'barangay', event: Event): void {
    if (kind === 'barangay' && !this.draft().cityCode) return;
    this.pickerTrigger = event.currentTarget as HTMLElement;
    this.picker.set(kind);
  }

  closePicker(): void {
    const trigger = this.pickerTrigger;
    this.picker.set(null);
    this.pickerTrigger = null;
    setTimeout(() => trigger?.focus());
  }

  chooseCity(city: GeographicOption): void {
    this.draft.update((current) => ({ ...current, cityCode: city.code, barangayCode: current.cityCode === city.code ? current.barangayCode : '' }));
    this.errors.update((current) => ({ ...current, cityCode: undefined, barangayCode: undefined }));
    this.closePicker();
  }

  chooseBarangay(barangay: GeographicOption): void {
    this.draft.update((current) => ({ ...current, barangayCode: barangay.code }));
    this.errors.update((current) => ({ ...current, barangayCode: undefined }));
    this.closePicker();
  }

  cityName(): string { return this.geography.city(this.draft().cityCode)?.name ?? ''; }
  barangayName(): string { return this.geography.barangays(this.draft().cityCode).find((entry) => entry.code === this.draft().barangayCode)?.name ?? ''; }

  async save(): Promise<void> {
    if (this.saving()) return;
    const errors = validateAddressDraft(this.draft());
    this.errors.set(errors);
    this.touched.set(new Set(Object.keys(EMPTY_ADDRESS).filter((key) => key !== 'makeDefault') as AddressField[]));
    if (Object.keys(errors).length) { await this.focusFirstError(errors); return; }
    this.saving.set(true);
    this.pageError.set('');
    const { makeDefault, ...input } = this.draft();
    try {
      if (this.editId()) await this.addressBook.update(this.editId(), input);
      else await this.addressBook.create({ ...input, makeDefault });
      await this.ui.toast(this.editId() ? 'Address updated.' : 'Address saved.', { icon: 'checkmark-circle' });
      await this.router.navigateByUrl('/profile/addresses');
    } catch (error) {
      this.errors.update((current) => ({ ...current, ...(apiFieldErrors(error) as AddressErrors) }));
      this.pageError.set(apiErrorMessage(error));
    } finally {
      this.saving.set(false);
    }
  }

  private validateField(field: AddressField): void {
    this.errors.update((current) => ({ ...current, [field]: validateAddressDraft(this.draft())[field] }));
  }

  private async focusFirstError(errors: AddressErrors): Promise<void> {
    const order: AddressField[] = ['label', 'recipientName', 'recipientPhone', 'addressLine1', 'addressLine2', 'cityCode', 'barangayCode', 'postalCode'];
    const field = order.find((candidate) => errors[candidate]);
    if (!field) return;
    await new Promise((resolve) => setTimeout(resolve));
    const element = document.getElementById(`address-${field}`) as (HTMLElement & { setFocus?: () => Promise<void> }) | null;
    element?.scrollIntoView({ behavior: 'auto', block: 'center' });
    await element?.setFocus?.();
  }
}
