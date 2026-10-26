/**
 * @file google-reauth-modal.component.spec.ts
 * @description Web Google step-up reauth sheet: renders the GIS button after the view is mounted
 * into a visible host, handles unavailable/missing-host/cancel, shows operation-specific copy, and
 * never replaces the session or links an identity (it only hands back the id token).
 */
import { ComponentRef } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ModalController } from '@ionic/angular';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GoogleAuthService } from '../core/google-auth.service';
import { GoogleReauthModalComponent } from './google-reauth-modal.component';

describe('GoogleReauthModalComponent', () => {
  const google = {
    prepareWebPage: vi.fn(),
    restoreWebPage: vi.fn(),
    resetWebInitialization: vi.fn(),
    renderWebButton: vi.fn(
      async (
        _host: HTMLElement,
        _clientId: string,
        _nonce: string,
        _cb: (t: string) => void,
        _opts?: { reinitialize?: boolean },
      ): Promise<void> => undefined,
    ),
  };
  const modal = { dismiss: vi.fn(async () => true) };

  beforeEach(() => {
    vi.clearAllMocks();
    TestBed.configureTestingModule({
      imports: [GoogleReauthModalComponent],
      providers: [
        { provide: GoogleAuthService, useValue: google },
        { provide: ModalController, useValue: modal },
      ],
    });
  });

  function mount(operation: 'change_email' | 'set_password' = 'set_password'):
    { fixture: ComponentFixture<GoogleReauthModalComponent>; ref: ComponentRef<GoogleReauthModalComponent> } {
    const fixture = TestBed.createComponent(GoogleReauthModalComponent);
    fixture.componentRef.setInput('webClientId', 'client-id');
    fixture.componentRef.setInput('nonce', 'nonce-123');
    fixture.componentRef.setInput('operation', operation);
    return { fixture, ref: fixture.componentRef };
  }

  async function flushFrame(): Promise<void> {
    // The component waits for requestAnimationFrame before rendering.
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    await Promise.resolve();
  }

  it('renders the GIS button into the mounted, visible host after the view initializes', async () => {
    const { fixture } = mount();
    fixture.detectChanges(); // ngOnInit + ngAfterViewInit
    await flushFrame();
    expect(google.resetWebInitialization).toHaveBeenCalled(); // fresh attempt each open
    expect(google.renderWebButton).toHaveBeenCalledTimes(1);
    const [host, clientId, nonce, , opts] = google.renderWebButton.mock.calls[0];
    expect(host).toBeInstanceOf(HTMLElement);
    expect((host as HTMLElement).hasAttribute('hidden')).toBe(false); // visible host, not display:none
    expect(clientId).toBe('client-id');
    expect(nonce).toBe('nonce-123');
    expect(opts).toEqual({ reinitialize: true }); // allows re-init with a fresh nonce
    expect(fixture.componentInstance.unavailable()).toBe(false);
    expect(fixture.componentInstance.loading()).toBe(false);
  });

  it('reopening after cancel resets GIS and renders again with a new nonce (no page refresh)', async () => {
    // First open at nonce-123.
    const first = mount();
    first.fixture.detectChanges();
    await flushFrame();
    expect(google.renderWebButton).toHaveBeenCalledTimes(1);
    // Cancel + destroy the first modal (supersedes its attempt via resetWebInitialization on destroy).
    first.fixture.componentInstance.cancel();
    first.fixture.destroy();
    const resetsAfterFirst = google.resetWebInitialization.mock.calls.length;
    expect(resetsAfterFirst).toBeGreaterThanOrEqual(2); // once on render, once on destroy

    // Second open with a DIFFERENT fresh nonce renders again (no throw, no refresh).
    const second = TestBed.createComponent(GoogleReauthModalComponent);
    second.componentRef.setInput('webClientId', 'client-id');
    second.componentRef.setInput('nonce', 'nonce-456');
    second.componentRef.setInput('operation', 'set_password');
    second.detectChanges();
    await flushFrame();
    expect(google.renderWebButton).toHaveBeenCalledTimes(2);
    const secondNonce = google.renderWebButton.mock.calls[1][2];
    expect(secondNonce).toBe('nonce-456');
    expect(second.componentInstance.unavailable()).toBe(false);
  });

  it('ignores a credential delivered after the modal was dismissed (callback isolation)', async () => {
    let capturedCb: ((t: string) => void) | undefined;
    google.renderWebButton.mockImplementationOnce(
      async (_host: HTMLElement, _clientId: string, _nonce: string, cb: (t: string) => void) => {
        capturedCb = cb; // capture but do not call yet
      },
    );
    const { fixture } = mount();
    fixture.detectChanges();
    await flushFrame();
    // User cancels before Google returns a credential.
    fixture.componentInstance.cancel();
    expect(modal.dismiss).toHaveBeenCalledWith(null, 'cancel');
    modal.dismiss.mockClear();
    // A late credential for the canceled attempt must NOT dismiss with a token (settled guard).
    capturedCb?.('late-token');
    expect(modal.dismiss).not.toHaveBeenCalled();
  });

  it('dismisses with the id token when GIS invokes the credential callback', async () => {
    google.renderWebButton.mockImplementationOnce(
      async (_host: HTMLElement, _clientId: string, _nonce: string, cb: (t: string) => void) => {
        cb('fresh-id-token');
      },
    );
    const { fixture } = mount();
    fixture.detectChanges();
    await flushFrame();
    expect(modal.dismiss).toHaveBeenCalledWith('fresh-id-token', 'reauthed');
  });

  it('shows an honest unavailable state when GIS fails to initialize (script blocked)', async () => {
    google.renderWebButton.mockRejectedValueOnce(new Error('Google sign-in could not load.'));
    const { fixture } = mount();
    fixture.detectChanges();
    await flushFrame();
    expect(fixture.componentInstance.unavailable()).toBe(true);
    expect(fixture.componentInstance.loading()).toBe(false);
    expect(modal.dismiss).not.toHaveBeenCalled();
  });

  it('uses set_password copy for the set-password operation', () => {
    const { fixture } = mount('set_password');
    expect(fixture.componentInstance.reason()).toContain('setting a password');
  });

  it('uses change_email copy for the change-email operation', () => {
    const { fixture } = mount('change_email');
    expect(fixture.componentInstance.reason()).toContain('changing your email');
  });

  it('cancels by dismissing with a cancel role and does not render a token', () => {
    const { fixture } = mount();
    fixture.componentInstance.cancel();
    expect(modal.dismiss).toHaveBeenCalledWith(null, 'cancel');
  });

  it('prepares and restores the referrer policy around its lifecycle', async () => {
    const { fixture } = mount();
    fixture.detectChanges();
    await flushFrame();
    expect(google.prepareWebPage).toHaveBeenCalledOnce();
    fixture.destroy();
    expect(google.restoreWebPage).toHaveBeenCalledOnce();
  });
});
