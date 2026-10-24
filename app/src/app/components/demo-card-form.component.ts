/**
 * @file demo-card-form.component.ts
 * @description Transient, allowlisted card-demo form that emits only a non-sensitive scenario ID.
 */
import { Component, EventEmitter, OnDestroy, Output, computed, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { IonIcon, IonInput } from '@ionic/angular';
import {
  DemoCardErrors,
  DemoCardFields,
  DemoCardFlow,
  cardDigits,
  demoCardFlow,
  detectCardBrand,
  formatCardNumber,
  formatExpiry,
  validateDemoCard,
} from '../core/demo-card';

const EMPTY_CARD: DemoCardFields = { name: '', number: '', expiry: '', cvc: '' };

@Component({
  selector: 'app-demo-card-form',
  imports: [FormsModule, IonIcon, IonInput],
  template: `
    <section class="demo-card" aria-labelledby="card-details-heading">
      <div class="section-heading">
        <div><h3 id="card-details-heading">Card details</h3><p>Enter the card information below.</p></div>
        <ion-icon name="lock-closed-outline" aria-hidden="true"></ion-icon>
      </div>

      <div class="card-preview" aria-label="Masked card preview">
        <span>{{ brand() || 'Credit / debit' }}</span>
        <strong>{{ maskedNumber() }}</strong>
        <small>{{ fields().name || 'Cardholder name' }} · {{ fields().expiry || 'MM/YY' }}</small>
      </div>

      <div class="field-group">
        <ion-input id="demo-card-name" class="cf-input" [class.ion-invalid]="shownError('name')" [class.ion-touched]="touched().has('name')" label="Cardholder name" labelPlacement="floating" autocomplete="off" autocapitalize="characters" [ngModel]="fields().name" (ngModelChange)="update('name', $event)" (ionBlur)="blur('name')"></ion-input>
        @if (shownError('name'); as message) { <p class="field-error" role="alert"><ion-icon name="alert-circle" aria-hidden="true"></ion-icon>{{ message }}</p> }
      </div>
      <div class="field-group">
        <ion-input id="demo-card-number" class="cf-input" [class.ion-invalid]="shownError('number')" [class.ion-touched]="touched().has('number')" type="text" inputmode="numeric" autocomplete="off" maxlength="19" label="Card number" labelPlacement="floating" [ngModel]="fields().number" (ngModelChange)="update('number', $event)" (ionBlur)="blur('number')"><ion-icon slot="end" name="card-outline" aria-hidden="true"></ion-icon></ion-input>
        @if (shownError('number'); as message) { <p class="field-error" role="alert"><ion-icon name="alert-circle" aria-hidden="true"></ion-icon>{{ message }}</p> }
      </div>
      <div class="card-row">
        <div class="field-group">
          <ion-input id="demo-card-expiry" class="cf-input" [class.ion-invalid]="shownError('expiry')" [class.ion-touched]="touched().has('expiry')" type="text" inputmode="numeric" autocomplete="off" maxlength="5" label="Expiry (MM/YY)" labelPlacement="floating" [ngModel]="fields().expiry" (ngModelChange)="update('expiry', $event)" (ionBlur)="blur('expiry')"></ion-input>
          @if (shownError('expiry'); as message) { <p class="field-error" role="alert"><ion-icon name="alert-circle" aria-hidden="true"></ion-icon>{{ message }}</p> }
        </div>
        <div class="field-group">
          <ion-input id="demo-card-cvc" class="cf-input" [class.ion-invalid]="shownError('cvc')" [class.ion-touched]="touched().has('cvc')" type="password" inputmode="numeric" autocomplete="off" maxlength="3" label="CVC" labelPlacement="floating" [ngModel]="fields().cvc" (ngModelChange)="update('cvc', $event)" (ionBlur)="blur('cvc')"></ion-input>
          @if (shownError('cvc'); as message) { <p class="field-error" role="alert"><ion-icon name="alert-circle" aria-hidden="true"></ion-icon>{{ message }}</p> }
        </div>
      </div>
      <p class="test-notice" role="note"><ion-icon name="information-circle-outline" aria-hidden="true"></ion-icon><span>Only synthetic test cards are allowed. Do not enter a real card. No money will be charged.</span></p>
    </section>
  `,
  styles: [`
    :host { display: block; margin-top: 16px; }
    .demo-card { display: grid; gap: 14px; }
    .section-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
    .section-heading h3 { margin: 0; font-size: 1rem; }
    .section-heading p { margin: 4px 0 0; color: var(--cf-choco-medium); font-size: .72rem; line-height: 1.45; }
    .section-heading ion-icon { flex: none; color: var(--cf-pink-deep); font-size: 1.25rem; }
    .card-preview { display: grid; gap: 10px; min-height: 138px; padding: 20px; border: 1px solid var(--cf-pink-border); border-radius: 20px; background: var(--cf-choco-btn); color: white; }
    .card-preview span { font-size: .72rem; font-weight: 700; text-transform: uppercase; letter-spacing: .08em; }
    .card-preview strong { align-self: center; font-family: var(--cf-font-display); font-size: clamp(1.05rem, 6vw, 1.35rem); letter-spacing: .08em; }
    .card-preview small { opacity: .86; font-size: .7rem; overflow-wrap: anywhere; }
    .field-group { min-width: 0; }
    .card-row { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 10px; }
    .test-notice { display: flex; align-items: flex-start; gap: 8px; margin: 0; padding: 0 2px; color: var(--cf-choco-medium); font-size: .7rem; line-height: 1.45; }
    .test-notice ion-icon { flex: none; margin-top: 2px; color: var(--cf-pink-deep); }
  `],
})
export class DemoCardFormComponent implements OnDestroy {
  @Output() readonly flowChange = new EventEmitter<DemoCardFlow | null>();

  readonly fields = signal<DemoCardFields>({ ...EMPTY_CARD });
  readonly errors = signal<DemoCardErrors>({});
  readonly touched = signal<ReadonlySet<keyof DemoCardFields>>(new Set());
  readonly brand = computed(() => detectCardBrand(this.fields().number));
  readonly maskedNumber = computed(() => {
    const digits = cardDigits(this.fields().number);
    return digits.length ? `•••• •••• •••• ${digits.slice(-4).padStart(4, '•')}` : '•••• •••• •••• ••••';
  });

  update(field: keyof DemoCardFields, value: unknown): void {
    const raw = String(value ?? '');
    const formatted = field === 'number'
      ? formatCardNumber(raw)
      : field === 'expiry'
        ? formatExpiry(raw)
        : field === 'cvc'
          ? raw.replace(/\D/g, '').slice(0, 3)
          : raw.toUpperCase().slice(0, 80);
    this.fields.update((current) => ({ ...current, [field]: formatted }));
    if (this.touched().has(field) || this.errors()[field]) this.validateCurrent();
    this.flowChange.emit(demoCardFlow(this.fields()));
  }

  blur(field: keyof DemoCardFields): void {
    this.touched.update((current) => new Set(current).add(field));
    this.validateCurrent();
  }

  shownError(field: keyof DemoCardFields): string | undefined {
    return this.touched().has(field) ? this.errors()[field] : undefined;
  }

  validate(): DemoCardFlow | null {
    this.touched.set(new Set(['name', 'number', 'expiry', 'cvc']));
    this.validateCurrent();
    const flow = Object.keys(this.errors()).length ? null : demoCardFlow(this.fields());
    this.flowChange.emit(flow);
    if (!flow) {
      const firstInvalid = (['name', 'number', 'expiry', 'cvc'] as const).find((field) => this.errors()[field]);
      if (firstInvalid) queueMicrotask(() => document.getElementById(`demo-card-${firstInvalid}`)?.focus());
    }
    return flow;
  }

  clear(): void {
    this.fields.set({ ...EMPTY_CARD });
    this.errors.set({});
    this.touched.set(new Set());
    this.flowChange.emit(null);
  }

  ngOnDestroy(): void {
    this.fields.set({ ...EMPTY_CARD });
  }

  private validateCurrent(): void {
    this.errors.set(validateDemoCard(this.fields()));
  }
}
