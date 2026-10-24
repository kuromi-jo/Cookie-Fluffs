/**
 * @file consent-modal.component.ts
 * @description Full-height Terms and Privacy consent window for signup.
 */
import { AfterViewInit, Component, DestroyRef, ElementRef, HostListener, Input, inject, signal, viewChild } from '@angular/core';
import {
  IonButton,
  IonButtons,
  IonContent,
  IonFooter,
  IonHeader,
  IonIcon,
  IonTitle,
  IonToolbar,
  ModalController,
} from '@ionic/angular';
import { PrivacyContentComponent } from './privacy-content.component';
import { TermsContentComponent } from './terms-content.component';

export function hasReachedScrollEnd(
  scrollElement: Pick<HTMLElement, 'scrollTop' | 'clientHeight' | 'scrollHeight'>,
): boolean {
  return scrollElement.scrollTop + scrollElement.clientHeight >= scrollElement.scrollHeight - 2;
}

@Component({
  selector: 'app-consent-modal',
  imports: [
    IonHeader,
    IonToolbar,
    IonTitle,
    IonButtons,
    IonButton,
    IonIcon,
    IonContent,
    IonFooter,
    TermsContentComponent,
    PrivacyContentComponent,
  ],
  template: `
    <ion-header class="cf-header">
      <ion-toolbar>
        <ion-title class="cf-title">{{ title }}</ion-title>
        <ion-buttons slot="end">
          <ion-button class="close" fill="clear" aria-label="Close" (click)="cancel()">
            <ion-icon slot="icon-only" name="close" aria-hidden="true"></ion-icon>
          </ion-button>
        </ion-buttons>
      </ion-toolbar>
    </ion-header>

    <ion-content #scrollArea>
      <div class="cf-page policy-body">
        @if (agreementVersion) {
          <p class="version-note"><span class="cf-chip">Draft for our class project</span><span>Agreement version {{ agreementVersion }}</span></p>
        }
        <section aria-labelledby="modal-terms-title">
          <h2 id="modal-terms-title" class="cf-section-title">Terms of Use</h2>
          <app-terms-content />
        </section>

        <section class="policy-section" aria-labelledby="modal-privacy-title">
          <h2 id="modal-privacy-title" class="cf-section-title">Privacy Policy</h2>
          <app-privacy-content />
        </section>

        <div #endSentinel class="end-sentinel" aria-hidden="true"></div>
      </div>
    </ion-content>

    <ion-footer>
      <div class="modal-footer">
        <p aria-live="polite">{{ canAgree() ? 'Thanks for reading.' : 'Scroll to the bottom to continue.' }}</p>
        <ion-button expand="block" class="cf-btn-lg" [disabled]="!canAgree()" (click)="agree()">{{ confirmLabel }}</ion-button>
        <ion-button expand="block" fill="clear" class="cancel" (click)="cancel()">{{ cancelLabel }}</ion-button>
      </div>
    </ion-footer>
  `,
  styles: `
    :host { display: flex; flex-direction: column; width: 100%; max-width: 100%; height: 100%; min-width: 0; overflow: hidden; background: var(--cf-canvas); }
    ion-header, ion-content, ion-footer { width: 100%; max-width: 100%; min-width: 0; }
    ion-content { --background: var(--cf-canvas); }
    ion-footer { background: var(--cf-canvas); box-shadow: none; }
    .close { width: 44px; height: 44px; --padding-start: 0; --padding-end: 0; }
    .policy-body { box-sizing: border-box; width: 100%; max-width: 100%; min-width: 0; padding-top: 20px; overflow-wrap: anywhere; }
    .version-note { display: grid; justify-items: start; gap: 8px; margin: 0 0 22px; color: var(--cf-choco-light); font-size: .72rem; line-height: 1.45; }
    .version-note .cf-chip { margin: 0; }
    .policy-body section, .policy-body .cf-card { min-width: 0; max-width: 100%; }
    .policy-section { margin-top: 28px; padding-top: 24px; border-top: 1px solid var(--cf-pink-border); }
    .end-sentinel { height: 1px; }
    .modal-footer { padding: 10px 20px calc(14px + var(--ion-safe-area-bottom)); border-top: 1px solid var(--cf-pink-border); }
    .modal-footer p { min-height: 18px; margin: 0 0 8px; color: var(--cf-choco-light); font-size: .75rem; font-weight: 700; text-align: center; }
    .modal-footer ion-button { margin: 0; }
    .modal-footer .cancel { min-height: 44px; margin-top: 4px; }
  `,
})
export class ConsentModalComponent implements AfterViewInit {
  @Input() title = 'Terms and Privacy';
  @Input() confirmLabel = 'I agree';
  @Input() cancelLabel = 'Close without agreeing';
  @Input() agreementVersion = '';
  private readonly modal = inject(ModalController);
  private readonly destroyRef = inject(DestroyRef);
  private readonly scrollArea = viewChild.required<IonContent>('scrollArea');
  private readonly endSentinel = viewChild.required<ElementRef<HTMLElement>>('endSentinel');
  private observer?: IntersectionObserver;
  private resizeObserver?: ResizeObserver;
  private closing = false;

  readonly canAgree = signal(false);

  ngAfterViewInit(): void {
    this.destroyRef.onDestroy(() => {
      this.observer?.disconnect();
      this.resizeObserver?.disconnect();
    });
    void this.watchEndOfText();
  }

  @HostListener('document:keydown.escape', ['$event'])
  closeOnEscape(event: Event): void {
    event.preventDefault();
    event.stopPropagation();
    this.cancel();
  }

  agree(): void {
    if (!this.canAgree() || this.closing) return;
    this.closing = true;
    void this.modal.dismiss(true, 'confirm');
  }

  cancel(): void {
    if (this.closing) return;
    this.closing = true;
    void this.modal.dismiss(null, 'cancel');
  }

  private async watchEndOfText(): Promise<void> {
    const scrollElement = await this.scrollArea().getScrollElement();
    const updateCanAgree = (): void => {
      if (hasReachedScrollEnd(scrollElement)) this.canAgree.set(true);
    };
    this.observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) this.canAgree.set(true);
      },
      { root: scrollElement, threshold: 1 },
    );
    this.observer.observe(this.endSentinel().nativeElement);
    this.resizeObserver = new ResizeObserver(updateCanAgree);
    this.resizeObserver.observe(scrollElement);
    this.resizeObserver.observe(this.endSentinel().nativeElement);
    updateCanAgree();
  }
}
