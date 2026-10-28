/**
 * @file admin-product-form.modal.ts
 * @description "Add product" sheet for the admin dashboard: photo, name, copy, category, season,
 * prices, allergens, calories, badge and menu switches. Validates on blur and on submit;
 * the server validates again and saves it to Neon.
 */
import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import {
  IonButton,
  IonButtons,
  IonContent,
  IonFooter,
  IonHeader,
  IonIcon,
  IonInput,
  IonSelect,
  IonSelectOption,
  IonSpinner,
  IonTextarea,
  IonTitle,
  IonToggle,
  IonToolbar,
  ModalController,
} from '@ionic/angular';
import {
  AdminService,
  NewProductInput,
  PRODUCT_ALLERGEN_OPTIONS,
  PRODUCT_BADGE_OPTIONS,
  PRODUCT_CATEGORY_OPTIONS,
} from '../core/admin.service';
import { UiService } from '../core/ui.service';
import { apiErrorMessage } from '../core/api-error';

type Field = 'image' | 'name' | 'tagline' | 'description' | 'flavorNotes' | 'category' | 'price' | 'salePrice' | 'calories' | 'badge';

/** Shrinks the picked photo to at most 640px and keeps transparency (WebP, PNG fallback). */
function toProductImage(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!/^image\/(png|jpeg|webp)$/.test(file.type)) return reject(new Error('Choose a PNG, JPEG or WebP photo.'));
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, 640 / Math.max(img.width, img.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext('2d')?.drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      let data = canvas.toDataURL('image/webp', 0.85);
      if (!data.startsWith('data:image/webp')) data = canvas.toDataURL('image/png');
      resolve(data);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('We couldn’t read that photo. Try another one.'));
    };
    img.src = url;
  });
}

@Component({
  selector: 'app-admin-product-form',
  imports: [
    FormsModule,
    IonHeader,
    IonToolbar,
    IonTitle,
    IonButtons,
    IonButton,
    IonIcon,
    IonContent,
    IonFooter,
    IonInput,
    IonTextarea,
    IonSelect,
    IonSelectOption,
    IonToggle,
    IonSpinner,
  ],
  template: `
    <ion-header class="cf-header">
      <ion-toolbar>
        <ion-title class="cf-title">Add product</ion-title>
        <ion-buttons slot="end">
          <ion-button (click)="close()" aria-label="Close">
            <ion-icon slot="icon-only" name="close" aria-hidden="true"></ion-icon>
          </ion-button>
        </ion-buttons>
      </ion-toolbar>
    </ion-header>

    <ion-content>
      <form class="cf-page form" (ngSubmit)="save()" novalidate>
        <!-- Photo -->
        <label class="photo" [class.invalid]="show('image')">
          @if (image()) {
            <img [src]="image()" alt="Product photo preview" />
          } @else {
            <span class="placeholder"><ion-icon name="camera-outline" aria-hidden="true"></ion-icon>Add a photo</span>
          }
          <input type="file" accept="image/png,image/jpeg,image/webp" (change)="pickImage($event)" aria-label="Product photo" />
          <small>{{ image() ? 'Tap to change the photo' : 'PNG with a transparent background looks best' }}</small>
        </label>
        @if (show('image')) { <p class="field-error" role="alert">{{ errors()['image'] }}</p> }

        <ion-input class="cf-input" label="Name" labelPlacement="floating" name="name" [(ngModel)]="v.name" (ionBlur)="touch('name')" maxlength="60" autocomplete="off"></ion-input>
        @if (show('name')) { <p class="field-error" role="alert">{{ errors()['name'] }}</p> }

        <ion-input class="cf-input" label="Tagline (one short line)" labelPlacement="floating" name="tagline" [(ngModel)]="v.tagline" (ionBlur)="touch('tagline')" maxlength="120"></ion-input>
        @if (show('tagline')) { <p class="field-error" role="alert">{{ errors()['tagline'] }}</p> }

        <ion-textarea class="cf-input" label="Description" labelPlacement="floating" name="description" [(ngModel)]="v.description" (ionBlur)="touch('description')" [autoGrow]="true" rows="3" maxlength="600"></ion-textarea>
        @if (show('description')) { <p class="field-error" role="alert">{{ errors()['description'] }}</p> }

        <ion-input class="cf-input" label="Flavor notes (e.g. Brown butter • Dark chocolate)" labelPlacement="floating" name="flavorNotes" [(ngModel)]="v.flavorNotes" (ionBlur)="touch('flavorNotes')" maxlength="80"></ion-input>
        @if (show('flavorNotes')) { <p class="field-error" role="alert">{{ errors()['flavorNotes'] }}</p> }

        <ion-select class="cf-input" label="Category" labelPlacement="floating" name="category" [(ngModel)]="v.category" (ionDismiss)="touch('category')" interface="action-sheet" [interfaceOptions]="categorySheet" placeholder="Choose a category">
          @for (c of categories; track c.id) { <ion-select-option [value]="c.id">{{ c.label }}</ion-select-option> }
        </ion-select>
        @if (show('category')) { <p class="field-error" role="alert">{{ errors()['category'] }}</p> }

        <div class="two">
          <div>
            <ion-input class="cf-input" type="number" inputmode="decimal" label="Price (₱)" labelPlacement="floating" name="price" [(ngModel)]="v.price" (ionBlur)="touch('price')"></ion-input>
            @if (show('price')) { <p class="field-error" role="alert">{{ errors()['price'] }}</p> }
          </div>
          <div>
            <ion-input class="cf-input" type="number" inputmode="decimal" label="Promo price (optional)" labelPlacement="floating" name="salePrice" [(ngModel)]="v.salePrice" (ionBlur)="touch('salePrice')"></ion-input>
            @if (show('salePrice')) { <p class="field-error" role="alert">{{ errors()['salePrice'] }}</p> }
          </div>
        </div>

        <div class="two">
          <div>
            <ion-input class="cf-input" type="number" inputmode="numeric" label="Calories" labelPlacement="floating" name="calories" [(ngModel)]="v.calories" (ionBlur)="touch('calories')"></ion-input>
            @if (show('calories')) { <p class="field-error" role="alert">{{ errors()['calories'] }}</p> }
          </div>
          <div>
            <!-- Always a dropdown. A promo price locks it to the automatic discount badge (e.g. "20% off"). -->
            <ion-select class="cf-input" label="Badge" labelPlacement="floating" name="badge" interface="action-sheet"
              [interfaceOptions]="badgeSheet" [disabled]="!!discountBadge()" [class.badge-auto]="!!discountBadge()"
              [ngModel]="discountBadge() ? AUTO_BADGE : v.badge" (ngModelChange)="setBadge($event)">
              @if (discountBadge(); as auto) { <ion-select-option [value]="AUTO_BADGE">{{ auto }} (automatic)</ion-select-option> }
              <ion-select-option value="">None</ion-select-option>
              @for (b of badgeOptions; track b) { <ion-select-option [value]="b">{{ b }}</ion-select-option> }
            </ion-select>
            @if (discountBadge()) { <p class="field-hint">Set automatically from the promo price.</p> }
          </div>
        </div>

        <fieldset class="allergens">
          <legend>Allergens</legend>
          <div class="chip-row">
            @for (a of allergenChoices(); track a) {
              <button type="button" class="pick" [class.on]="allergens().has(a)" [attr.aria-pressed]="allergens().has(a)" (click)="toggleAllergen(a)">
                @if (allergens().has(a)) { <ion-icon name="checkmark" aria-hidden="true"></ion-icon> }
                {{ a }}
              </button>
            }
          </div>
          <div class="add-allergen">
            <ion-input class="cf-input" label="Add another allergen" labelPlacement="floating" name="customAllergen" [(ngModel)]="customAllergen" (keyup.enter)="addAllergen()" maxlength="24" autocomplete="off"></ion-input>
            <ion-button fill="outline" (click)="addAllergen()" [disabled]="!customAllergen.trim()">Add</ion-button>
          </div>
          @if (allergenError()) { <p class="field-error" role="alert">{{ allergenError() }}</p> }
        </fieldset>

        <div class="switches cf-card">
          <ion-toggle [(ngModel)]="v.isAvailable" name="isAvailable" labelPlacement="start" justify="space-between">On the menu</ion-toggle>
          <ion-toggle [(ngModel)]="v.isNew" name="isNew" labelPlacement="start" justify="space-between">Show in “Fresh from the oven”</ion-toggle>
          <ion-toggle [(ngModel)]="v.halloween" name="halloween" labelPlacement="start" justify="space-between" (ionChange)="onHalloween()">
            <span class="hw-label">Halloween special<small>Shown in Halloween specials; orderable Oct 1 to Nov 30</small></span>
          </ion-toggle>
          <p class="hint">Best sellers are picked automatically from the most-ordered cookies.</p>
        </div>

        @if (serverError()) { <p class="server-error" role="alert"><ion-icon name="alert-circle-outline" aria-hidden="true"></ion-icon>{{ serverError() }}</p> }
        <button type="submit" hidden></button>
      </form>
    </ion-content>

    <ion-footer class="foot">
      <ion-button expand="block" class="cf-btn-lg" [disabled]="saving()" (click)="save()">
        @if (saving()) { <ion-spinner name="crescent"></ion-spinner> } @else { Add product }
      </ion-button>
    </ion-footer>
  `,
  styles: `
    .form { padding-top: 14px; }
    .photo {
      position: relative; display: flex; flex-direction: column; align-items: center; gap: 6px;
      margin-bottom: 16px; cursor: pointer;
    }
    .photo img, .placeholder {
      width: 168px; height: 168px; border-radius: 28px; background: var(--cf-pink-soft); object-fit: contain;
    }
    .placeholder {
      display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 6px;
      border: 2px dashed var(--cf-pink-border); color: var(--cf-pink-deep); font-weight: 800; font-size: .85rem;
    }
    .placeholder ion-icon { font-size: 30px; }
    .photo.invalid .placeholder { border-color: var(--ion-color-danger); }
    .photo input { position: absolute; inset: 0; opacity: 0; cursor: pointer; }
    .photo small { font-size: .74rem; font-weight: 600; color: var(--cf-choco-light); }
    .field-error { margin: -8px 6px 12px; font-size: .76rem; font-weight: 700; color: var(--ion-color-danger); }
    .two { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
    .allergens { margin: 0 0 16px; padding: 0; border: 0; }
    .allergens legend { margin-bottom: 8px; font-size: .8rem; font-weight: 800; color: var(--cf-choco-medium); }
    .chip-row { display: flex; flex-wrap: wrap; gap: 8px; }
    .pick {
      display: inline-flex; align-items: center; gap: 4px; min-height: 40px; padding: 0 14px;
      border: 1px solid var(--cf-pink-border); border-radius: 999px; background: #fff;
      color: var(--cf-choco); font: inherit; font-size: .8rem; font-weight: 700; cursor: pointer;
    }
    .pick.on { border-color: var(--cf-choco-btn); background: var(--cf-choco-btn); color: var(--cf-canvas); }
    .switches { display: grid; gap: 4px; padding: 6px 16px; }
    .switches ion-toggle { min-height: 48px; font-weight: 700; --track-background-checked: var(--cf-pink-deep); }
    .hw-label { display: flex; flex-direction: column; white-space: normal; }
    .hw-label small, .hint { font-size: .72rem; font-weight: 600; color: var(--cf-choco-light); }
    .hint { margin: 2px 0 10px; }
    .field-hint { margin: -8px 6px 12px; font-size: .72rem; font-weight: 700; color: var(--cf-pink-deep); }
    /* Locked to the automatic discount badge: keep it readable (not the faded disabled look). */
    ion-select.badge-auto { opacity: 1 !important; color: var(--cf-pink-deep); font-weight: 800; }
    .add-allergen { display: flex; align-items: flex-start; gap: 8px; margin-top: 12px; }
    .add-allergen ion-input { flex: 1; }
    .add-allergen ion-button { min-height: 52px; margin: 3px 0 0; }
    .server-error {
      display: flex; align-items: center; gap: 8px; margin: 14px 0 0; padding: 10px 14px; border-radius: 14px;
      background: var(--cf-pink-card); border: 1px solid var(--cf-pink-border);
      color: var(--ion-color-danger); font-size: .84rem; font-weight: 700;
    }
    .foot { padding: 10px 18px calc(10px + env(safe-area-inset-bottom)); background: #fff; border-top: 1px solid var(--cf-pink-soft); }
    .foot::before { display: none; }
    .foot ion-button { margin: 0; }
    .foot ion-spinner { color: #fff; }
  `,
})
export class AdminProductFormComponent {
  private admin = inject(AdminService);
  private modal = inject(ModalController);
  private ui = inject(UiService);

  readonly categories = PRODUCT_CATEGORY_OPTIONS;
  readonly badgeOptions = PRODUCT_BADGE_OPTIONS;
  /** Both dropdowns open as the same slide-up sheet (same animation and look). */
  readonly categorySheet = { header: 'Choose a category', cssClass: 'cf-select-sheet' };
  readonly badgeSheet = { header: 'Choose a badge', cssClass: 'cf-select-sheet' };

  v = {
    name: '',
    tagline: '',
    description: '',
    flavorNotes: '',
    category: '',
    halloween: false,
    price: '' as string | number,
    salePrice: '' as string | number,
    calories: '' as string | number,
    badge: '',
    isAvailable: true,
    isNew: true,
  };

  /** Typed into "Add another allergen". */
  customAllergen = '';
  /** Allergens added by the admin beyond the usual list. */
  private readonly customAllergens = signal<string[]>([]);
  readonly allergenError = signal('');
  allergenChoices(): string[] {
    return [...PRODUCT_ALLERGEN_OPTIONS, ...this.customAllergens()];
  }

  /** "25% off" while a valid promo price is entered (the server sets the same badge). */
  discountBadge(): string | null {
    const price = Number(this.v.price);
    const sale = String(this.v.salePrice).trim() === '' ? NaN : Number(this.v.salePrice);
    if (!(price > 0) || !(sale > 0) || sale >= price) return null;
    return `${Math.max(1, Math.round((1 - sale / price) * 100))}% off`;
  }

  /** Placeholder value shown in the Badge dropdown while a promo price sets the badge. */
  readonly AUTO_BADGE = '__auto';

  setBadge(value: string): void {
    if (value === this.AUTO_BADGE) return;
    this.v.badge = value ?? '';
    this.onBadge();
  }

  /** Choosing the New badge also lists the cookie in "Fresh from the oven". */
  onBadge(): void {
    if (this.v.badge === 'New') this.v.isNew = true;
    if (this.v.badge === 'Halloween') this.v.halloween = true;
  }

  /** A Halloween special gets the Halloween badge unless another badge was picked. */
  onHalloween(): void {
    if (this.v.halloween && !this.v.badge) this.v.badge = 'Halloween';
    if (!this.v.halloween && this.v.badge === 'Halloween') this.v.badge = '';
  }

  addAllergen(): void {
    const cleaned = this.customAllergen.trim().replace(/s+/g, ' ');
    if (!cleaned) return;
    if (cleaned.length < 2 || !/^[A-Za-z][A-Za-z .'&-]*$/.test(cleaned)) {
      this.allergenError.set('Use letters only, at least 2, like “Sesame”.');
      return;
    }
    const label = cleaned.charAt(0).toUpperCase() + cleaned.slice(1).toLowerCase();
    const existing = this.allergenChoices().find((a) => a.toLowerCase() === label.toLowerCase());
    if (!existing && this.allergenChoices().length >= 16) {
      this.allergenError.set('That’s a lot of allergens. Remove one before adding another.');
      return;
    }
    if (!existing) this.customAllergens.update((list) => [...list, label]);
    const chosen = existing ?? label;
    if (this.allergens().size >= 10 && !this.allergens().has(chosen)) {
      this.allergenError.set('List up to 10 allergens.');
      return;
    }
    this.allergens.update((set) => new Set(set).add(chosen));
    this.customAllergen = '';
    this.allergenError.set('');
  }

  readonly image = signal<string | null>(null);
  readonly allergens = signal<ReadonlySet<string>>(new Set());
  readonly touched = signal<ReadonlySet<Field>>(new Set());
  readonly submitted = signal(false);
  readonly saving = signal(false);
  readonly serverError = signal('');
  readonly errors = signal<Partial<Record<Field, string>>>({});

  touch(field: Field): void {
    this.touched.update((s) => new Set(s).add(field));
    this.validate();
  }

  show(field: Field): boolean {
    return !!this.errors()[field] && (this.submitted() || this.touched().has(field));
  }

  toggleAllergen(a: string): void {
    this.allergens.update((s) => {
      const next = new Set(s);
      if (next.has(a)) next.delete(a);
      else next.add(a);
      return next;
    });
  }

  async pickImage(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    try {
      this.image.set(await toProductImage(file));
    } catch (err) {
      void this.ui.toast(err instanceof Error ? err.message : 'We couldn’t use that photo.', { error: true });
    }
    this.touch('image');
  }

  /** Mirrors the server rules so mistakes show next to the field before saving. */
  private validate(): boolean {
    const e: Partial<Record<Field, string>> = {};
    const len = (s: string) => s.trim().length;
    if (!this.image()) e.image = 'Add a product photo.';
    if (len(this.v.name) < 2) e.name = 'Enter a name (at least 2 characters).';
    if (len(this.v.tagline) < 2) e.tagline = 'Add a short tagline (at least 2 characters).';
    if (len(this.v.description) < 10) e.description = 'Describe the cookie in at least 10 characters.';
    if (len(this.v.flavorNotes) < 2) e.flavorNotes = 'Add flavor notes, for example “Caramel • Pecan”.';
    if (!this.v.category) e.category = 'Choose a category.';
    const price = Number(this.v.price);
    if (!(price > 0)) e.price = 'Enter a price above ₱0.';
    if (String(this.v.salePrice).trim() !== '') {
      const sale = Number(this.v.salePrice);
      if (!(sale > 0)) e.salePrice = 'Enter a promo price above ₱0, or leave it empty.';
      else if (price > 0 && sale >= price) e.salePrice = 'Promo price must be lower than the price.';
    }
    if (String(this.v.calories).trim() !== '') {
      const cal = Number(this.v.calories);
      if (!Number.isInteger(cal) || cal < 0 || cal > 2000) e.calories = 'Use a whole number from 0 to 2000.';
    }
    this.errors.set(e);
    return Object.keys(e).length === 0;
  }

  async save(): Promise<void> {
    this.submitted.set(true);
    this.serverError.set('');
    if (!this.validate() || this.saving()) return;
    const input: NewProductInput = {
      name: this.v.name,
      tagline: this.v.tagline,
      description: this.v.description,
      flavorNotes: this.v.flavorNotes,
      category: this.v.category,
      season: this.v.halloween ? 'halloween' : null,
      price: Number(this.v.price),
      salePrice: String(this.v.salePrice).trim() === '' ? null : Number(this.v.salePrice),
      calories: String(this.v.calories).trim() === '' ? 0 : Number(this.v.calories),
      allergens: [...this.allergens()],
      // The server replaces this with "N% off" when there is a promo price.
      badge: this.v.badge || null,
      isAvailable: this.v.isAvailable,
      isNew: this.v.isNew,
      isBestSeller: false,
      image: this.image()!,
    };
    this.saving.set(true);
    try {
      const created = await this.admin.createProduct(input);
      void this.ui.toast(`${created.name} added to the menu`);
      await this.modal.dismiss(created, 'created');
    } catch (err) {
      this.serverError.set(apiErrorMessage(err)); // keep everything the admin typed
    } finally {
      this.saving.set(false);
    }
  }

  close(): void {
    void this.modal.dismiss(null, 'cancel');
  }
}
