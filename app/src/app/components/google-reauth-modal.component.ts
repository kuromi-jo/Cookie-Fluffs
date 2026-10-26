/**
 * @file google-reauth-modal.component.ts
 * @description Web-only Google step-up reauthentication sheet. Renders the Google Identity
 * Services button for the authenticated, Google-linked customer and resolves with a FRESH Google
 * ID token (dismiss role 'reauthed'). It never logs in, links, or replaces the app session; the
 * token is handed back to the caller, which exchanges it for a purpose-bound reauth proof. If GIS
 * cannot load, an honest "unavailable" state is shown instead of a broken control. The nonce and
 * client id are provided by the caller (a purpose-bound reauth nonce). Rendering happens after the
 * view is laid out (requestAnimationFrame) and into a VISIBLE host, mirroring the login page, so
 * GIS has a real, non-hidden element to draw into.
 */
import {
  AfterViewInit,
  Component,
  DestroyRef,
  ElementRef,
  OnInit,
  inject,
  input,
  signal,
  viewChild,
} from '@angular/core';
import { IonButton, IonIcon, IonSpinner, ModalController } from '@ionic/angular';
import { GoogleAuthService } from '../core/google-auth.service';

type ReauthOperation = 'change_email' | 'set_password';

const OPERATION_REASON: Record<ReauthOperation, string> = {
  change_email: 'For your security, sign in with Google again before changing your email.',
  set_password: 'For your security, sign in with Google again before setting a password.',
};

@Component({
  selector: 'app-google-reauth-modal',
  imports: [IonButton, IonIcon, IonSpinner],
  template: `
    <div class="verify-sheet">
      <header class="verify-head">
        <span class="verify-mark"><ion-icon name="shield-checkmark-outline" aria-hidden="true"></ion-icon></span>
        <h2 id="google-reauth-title">Confirm it's you</h2>
        <p class="cf-muted">{{ reason() }}</p>
      </header>

      @if (loading()) {
        <div class="verify-loading" role="status"><ion-spinner name="crescent"></ion-spinner><span>Preparing Google sign-in\u2026</span></div>
      }
      @if (unavailable()) {
        <div class="verify-notice" role="alert">
          <ion-icon name="alert-circle" aria-hidden="true"></ion-icon>
          <p>We couldn't start Google sign-in. Please try again later.</p>
        </div>
      }
      <!-- Always present and never display:none, so GIS can draw a real, visible button here. -->
      <div #buttonHost class="google-reauth-host"></div>
      <ion-button expand="block" fill="clear" class="verify-cancel" (click)="cancel()">Cancel</ion-button>
    </div>
  `,
  styleUrls: ['./verification-modal.component.scss'],
})
export class GoogleReauthModalComponent implements OnInit, AfterViewInit {
  readonly webClientId = input.required<string>();
  readonly nonce = input.required<string>();
  /** Drives the explanatory copy; defaults to change_email for backward compatibility. */
  readonly operation = input<ReauthOperation>('change_email');

  private google = inject(GoogleAuthService);
  // Named modalCtrl (not `modal`) to avoid colliding with Ionic's reserved `modal` instance
  // property, which the angular-delegate assigns when presenting this component as a modal.
  private modalCtrl = inject(ModalController);
  private destroyRef = inject(DestroyRef);

  private readonly buttonHost = viewChild<ElementRef<HTMLDivElement>>('buttonHost');

  readonly loading = signal(true);
  readonly unavailable = signal(false);
  private settled = false;

  reason(): string {
    return OPERATION_REASON[this.operation()];
  }

  ngOnInit(): void {
    this.google.prepareWebPage();
    this.destroyRef.onDestroy(() => {
      this.google.restoreWebPage();
      // Supersede any in-flight attempt so a late GIS callback after close is ignored, and the
      // next open re-initializes cleanly.
      this.google.resetWebInitialization();
    });
  }

  ngAfterViewInit(): void {
    // Render only after the view exists, so the button host is present and laid out.
    void this.renderButton();
  }

  private async renderButton(): Promise<void> {
    // Wait for a real paint frame (not just a microtask) so the host has layout, mirroring the
    // proven login-page sequence. GIS refuses to draw into a missing or display:none element.
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const element = this.buttonHost()?.nativeElement;
    if (!element) {
      this.loading.set(false);
      this.unavailable.set(true);
      return;
    }
    try {
      // Fresh attempt each open: reset any prior GIS init so this modal's fresh, purpose-bound
      // nonce re-initializes cleanly (supports cancel -> reopen without a page refresh).
      this.google.resetWebInitialization();
      await this.google.renderWebButton(
        element,
        this.webClientId(),
        this.nonce(),
        (idToken) => {
          if (this.settled) return;
          this.settled = true;
          void this.modalCtrl.dismiss(idToken, 'reauthed');
        },
        { reinitialize: true },
      );
      // Host stays visible; just drop the spinner now that the button is drawn.
      this.loading.set(false);
    } catch {
      this.loading.set(false);
      this.unavailable.set(true);
    }
  }

  cancel(): void {
    if (this.settled) return;
    this.settled = true;
    void this.modalCtrl.dismiss(null, 'cancel');
  }
}
