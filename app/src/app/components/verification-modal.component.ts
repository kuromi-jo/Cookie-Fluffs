/**
 * @file verification-modal.component.ts
 * @description Reusable mobile verification sheet for protected account changes. Presented as a
 * bounded bottom-sheet modal (see .verify-sheet-modal in global.scss). It starts a challenge,
 * collects the 6-digit code, shows a countdown and resend cooldown, and returns a verified
 * authorization handle via ModalController.dismiss. When the server reports delivery is not yet
 * enabled, the sheet shows an honest "not available" state instead of a non-functional control.
 */
import { Component, DestroyRef, OnInit, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { HttpErrorResponse } from '@angular/common/http';
import { IonButton, IonIcon, IonInput, IonSpinner, ModalController } from '@ionic/angular';
import { apiErrorMessage } from '../core/api-error';
import {
  VerificationOperation,
  VerificationService,
  VerificationStart,
} from '../core/verification.service';

const OPERATION_COPY: Record<VerificationOperation, { title: string; reason: string }> = {
  change_phone: {
    title: 'Confirm it\u2019s you',
    reason: 'For your security, confirm your identity before changing your mobile number.',
  },
  change_email: {
    title: 'Confirm it\u2019s you',
    reason: 'For your security, confirm your identity before changing your email address.',
  },
  set_password: {
    title: 'Confirm it\u2019s you',
    reason: 'For your security, confirm your identity before setting an account password.',
  },
  change_password: {
    title: 'Confirm it\u2019s you',
    reason: 'For your security, confirm your identity before changing your password.',
  },
};

@Component({
  selector: 'app-verification-modal',
  imports: [FormsModule, IonButton, IonIcon, IonInput, IonSpinner],
  template: `
    <div class="verify-sheet">
      <header class="verify-head">
        <span class="verify-mark"><ion-icon name="shield-checkmark-outline" aria-hidden="true"></ion-icon></span>
        <h2 id="verify-title">{{ copy().title }}</h2>
        <p class="cf-muted">{{ copy().reason }}</p>
      </header>

      @if (loadingStart()) {
        <div class="verify-loading" role="status"><ion-spinner name="crescent"></ion-spinner><span>Preparing verification\u2026</span></div>
      } @else if (unavailable()) {
        <div class="verify-notice" role="alert">
          <ion-icon name="information-circle-outline" aria-hidden="true"></ion-icon>
          <p>Verification delivery isn\u2019t turned on yet, so we can\u2019t send a code right now. Please try again later.</p>
        </div>
        <ion-button expand="block" fill="clear" (click)="cancel()">Close</ion-button>
      } @else if (deliveryFailed()) {
        <div class="verify-notice" role="alert">
          <ion-icon name="alert-circle" aria-hidden="true"></ion-icon>
          <p>{{ failureMessage() }}</p>
        </div>
        <ion-button
          expand="block"
          class="cf-btn-lg"
          [disabled]="submitting() || retryIn() > 0"
          (click)="retryDelivery()"
        >
          @if (submitting()) { <ion-spinner name="crescent"></ion-spinner> }
          @else if (retryIn() > 0) { Try again in {{ retryIn() }}s }
          @else { Try again }
        </ion-button>
        <ion-button expand="block" fill="clear" (click)="cancel()">Cancel</ion-button>
      } @else if (cooldown()) {
        <div class="verify-notice" role="alert">
          <ion-icon name="information-circle-outline" aria-hidden="true"></ion-icon>
          <p>Please wait a moment before requesting another code.</p>
        </div>
        <ion-button
          expand="block"
          class="cf-btn-lg"
          [disabled]="submitting() || retryIn() > 0"
          (click)="retryAfterCooldown()"
        >
          @if (submitting()) { <ion-spinner name="crescent"></ion-spinner> }
          @else if (retryIn() > 0) { Try again in {{ retryIn() }}s }
          @else { Try again }
        </ion-button>
        <ion-button expand="block" fill="clear" (click)="cancel()">Cancel</ion-button>
      } @else {
        @if (started(); as info) {
          <p class="verify-dest">
            We sent a 6-digit code to
            <strong>{{ info.maskedDestination || 'your email' }}</strong>.
          </p>
          <div class="field-group">
            <ion-input
              #codeInput
              class="cf-input verify-code"
              label="Verification code"
              labelPlacement="floating"
              inputmode="numeric"
              autocomplete="one-time-code"
              maxlength="6"
              [value]="code()"
              (ionInput)="onCode($any($event.target).value)"
              aria-describedby="verify-timer"
            ></ion-input>
          </div>
          <p id="verify-timer" class="verify-timer" [class.expired]="secondsLeft() === 0">
            @if (secondsLeft() > 0) { Code expires in {{ minuteLabel() }} } @else { Your code has expired. Request a new one. }
          </p>
          @if (error()) { <p class="form-error" role="alert"><ion-icon name="alert-circle" aria-hidden="true"></ion-icon>{{ error() }}</p> }

          <ion-button expand="block" class="cf-btn-lg" [disabled]="submitting() || code().length !== 6" (click)="submit()">
            @if (submitting()) { <ion-spinner name="crescent"></ion-spinner> } @else { Verify }
          </ion-button>
          <ion-button expand="block" fill="clear" [disabled]="resendIn() > 0 || submitting()" (click)="resend()">
            @if (resendIn() > 0) { Resend code in {{ resendIn() }}s } @else { Resend code }
          </ion-button>
          <ion-button expand="block" fill="clear" class="verify-cancel" (click)="cancel()">Cancel</ion-button>
        }
      }
    </div>
  `,
  styleUrls: ['./verification-modal.component.scss'],
})
export class VerificationModalComponent implements OnInit {
  readonly operation = input.required<VerificationOperation>();
  /** Optional target (new email/phone) bound to the challenge. */
  readonly target = input<string | null>(null);

  private verification = inject(VerificationService);
  // Named modalCtrl (not `modal`) to avoid colliding with Ionic's reserved `modal` instance
  // property, which the angular-delegate assigns when presenting this component as a modal.
  private modalCtrl = inject(ModalController);
  private destroyRef = inject(DestroyRef);

  readonly loadingStart = signal(true);
  readonly unavailable = signal(false);
  readonly deliveryFailed = signal(false);
  readonly failureMessage = signal('We couldn\u2019t send your code. Please try again.');
  /** True when the server reported a resend cooldown (HTTP 429) at start; shows a live countdown. */
  readonly cooldown = signal(false);
  readonly started = signal<VerificationStart | null>(null);
  readonly code = signal('');
  readonly error = signal<string | null>(null);
  readonly submitting = signal(false);
  readonly secondsLeft = signal(0);
  readonly resendIn = signal(0);
  /** Countdown that gates the retry button after an unconfirmed (ambiguous) delivery failure. */
  readonly retryIn = signal(0);

  private timer: ReturnType<typeof setInterval> | null = null;

  copy(): { title: string; reason: string } {
    return OPERATION_COPY[this.operation()];
  }

  ngOnInit(): void {
    void this.beginChallenge();
    this.destroyRef.onDestroy(() => this.stopTimer());
  }

  private async beginChallenge(): Promise<void> {
    if (this.started() || this.unavailable()) return;
    this.loadingStart.set(true);
    this.error.set(null);
    this.deliveryFailed.set(false);
    this.cooldown.set(false);
    try {
      const info = await this.verification.start(this.operation(), this.target());
      if (!info.deliveryEnabled) {
        // Honest state: do not present a working code entry when nothing was delivered.
        this.unavailable.set(true);
        this.started.set(null);
        return;
      }
      if (!info.delivered) {
        // Delivery was attempted but not confirmed. Never show a code field for an email that
        // did not go out. canRetry (confirmed rejection) allows an immediate retry; an ambiguous
        // failure asks the user to wait before retrying so we do not trigger a duplicate send.
        this.started.set(null);
        this.deliveryFailed.set(true);
        if (info.canRetry) {
          this.failureMessage.set('We couldn\u2019t send your code. Please try again.');
          this.retryIn.set(0);
        } else {
          this.failureMessage.set(
            'We couldn\u2019t confirm your code was sent. Wait a moment, then try again. '
            + 'If an email already arrived, use that code.',
          );
          this.retryIn.set(60);
          this.startTimer();
        }
        return;
      }
      this.started.set(info);
      this.secondsLeft.set(info.expiresInMinutes * 60);
      this.resendIn.set(60);
      this.startTimer();
    } catch (err) {
      this.handleStartError(err);
    } finally {
      this.loadingStart.set(false);
    }
  }

  /** Retry after a delivery failure. Starts a fresh challenge from a clean state. */
  async retryDelivery(): Promise<void> {
    if (this.submitting() || this.retryIn() > 0) return;
    this.stopTimer();
    this.deliveryFailed.set(false);
    this.started.set(null);
    this.code.set('');
    await this.beginChallenge();
  }

  onCode(value: string): void {
    this.code.set((value ?? '').replace(/\D/g, '').slice(0, 6));
    this.error.set(null);
  }

  async submit(): Promise<void> {
    const challengeId = this.started()?.challengeId;
    if (this.submitting() || this.code().length !== 6 || !challengeId) return;
    this.submitting.set(true);
    this.error.set(null);
    try {
      const result = await this.verification.verify(
        challengeId, this.operation(), this.code(), this.target(),
      );
      this.stopTimer();
      await this.modalCtrl.dismiss(result, 'verified');
    } catch (err) {
      this.error.set(apiErrorMessage(err));
      this.code.set('');
    } finally {
      this.submitting.set(false);
    }
  }

  async resend(): Promise<void> {
    if (this.resendIn() > 0) return;
    this.started.set(null);
    this.code.set('');
    this.stopTimer();
    await this.beginChallenge();
  }

  cancel(): void {
    this.stopTimer();
    void this.modalCtrl.dismiss(null, 'cancel');
  }

  minuteLabel(): string {
    const s = this.secondsLeft();
    const m = Math.floor(s / 60);
    const sec = String(s % 60).padStart(2, '0');
    return `${m}:${sec}`;
  }

  private handleStartError(err: unknown): void {
    if (err instanceof HttpErrorResponse && err.status === 503) {
      this.unavailable.set(true);
      return;
    }
    // Resend cooldown / rate limit: show a dedicated waiting state with a live countdown derived
    // from the server's Retry-After (never auto-resend; the user must press Try again).
    if (err instanceof HttpErrorResponse && err.status === 429) {
      const retryAfter = Number(err.error?.retryAfter);
      this.cooldown.set(true);
      this.started.set(null);
      this.retryIn.set(Number.isFinite(retryAfter) && retryAfter > 0 ? Math.ceil(retryAfter) : 60);
      this.startTimer();
      return;
    }
    this.error.set(apiErrorMessage(err));
  }

  /** Retry after a cooldown has elapsed. Starts a fresh challenge from a clean state. */
  async retryAfterCooldown(): Promise<void> {
    if (this.submitting() || this.retryIn() > 0) return;
    this.stopTimer();
    this.cooldown.set(false);
    this.started.set(null);
    this.code.set('');
    await this.beginChallenge();
  }

  private startTimer(): void {
    this.stopTimer();
    this.timer = setInterval(() => {
      if (this.secondsLeft() > 0) this.secondsLeft.update((v) => v - 1);
      if (this.resendIn() > 0) this.resendIn.update((v) => v - 1);
      if (this.retryIn() > 0) this.retryIn.update((v) => v - 1);
    }, 1000);
  }

  private stopTimer(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
