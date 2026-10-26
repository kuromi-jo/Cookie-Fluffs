/**
 * @file login.page.spec.ts
 * @description Google authentication completion, explicit linking, and duplicate-action tests.
 */
import { HttpErrorResponse } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router } from '@angular/router';
import { ModalController, NavController } from '@ionic/angular';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthService } from '../../core/auth.service';
import { GoogleAuthService } from '../../core/google-auth.service';
import { UiService } from '../../core/ui.service';
import { LoginPage } from './login.page';

describe('LoginPage Google authentication', () => {
  const auth = {
    googleAuthConfig: vi.fn(async () => ({
      enabled: true, webClientId: '123456789-cookie-fluffs.apps.googleusercontent.com',
    })),
    googleNonce: vi.fn(async () => ({ selector: 'selector', nonce: 'nonce' })),
    authenticateWithGoogle: vi.fn(async () => ({ fullName: 'Mara Santos', firstName: 'Mara' })),
    completeGoogleSignup: vi.fn(),
    linkGoogleAccount: vi.fn(),
  };
  const google = {
    isNativeAndroid: true,
    nativeIdToken: vi.fn(async () => 'transient-id-token'),
    renderWebButton: vi.fn(),
    prepareWebPage: vi.fn(),
    restoreWebPage: vi.fn(),
    restartWebPage: vi.fn(),
    consumeRestartNotice: vi.fn(() => null as 'link' | 'retry' | null),
    hasInitializedWebAttempt: vi.fn(() => false),
  };
  const nav = { navigateRoot: vi.fn(async () => true) };
  const ui = { toast: vi.fn(async () => undefined) };
  // Records the URL that syncModeQueryParam would produce before a reload.
  const router = {
    navigateByUrl: vi.fn(),
    createUrlTree: vi.fn((_commands: unknown[], extras: { queryParams?: Record<string, string> }) => ({
      queryParams: extras?.queryParams ?? {},
    })),
    serializeUrl: vi.fn((tree: { queryParams: Record<string, string> }) => {
      const query = new URLSearchParams(tree.queryParams).toString();
      return query ? `/login?${query}` : '/login';
    }),
  };
  let queryMode: string | null = null;
  const activatedRoute = {
    snapshot: { queryParamMap: { get: (key: string) => (key === 'mode' ? queryMode : null) } },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    google.isNativeAndroid = true;
    queryMode = null;
    auth.authenticateWithGoogle.mockResolvedValue({ fullName: 'Mara Santos', firstName: 'Mara' });
    auth.linkGoogleAccount.mockResolvedValue({ fullName: 'Mara Santos', firstName: 'Mara' });
    TestBed.configureTestingModule({ providers: [
      { provide: AuthService, useValue: auth },
      { provide: GoogleAuthService, useValue: google },
      { provide: NavController, useValue: nav },
      { provide: Router, useValue: router },
      { provide: ActivatedRoute, useValue: activatedRoute },
      { provide: ModalController, useValue: {} },
      { provide: UiService, useValue: ui },
    ] });
  });

  const page = () => TestBed.runInInjectionContext(() => new LoginPage());

  it('uses one nonce and forwards the transient native credential to the backend once', async () => {
    const component = page();
    component.ngAfterViewInit();
    await vi.waitFor(() => expect(component.googleEnabled()).toBe(true));
    await component.startNativeGoogle();
    expect(auth.googleNonce).toHaveBeenCalledOnce();
    expect(auth.googleNonce).toHaveBeenCalledWith('login');
    expect(google.nativeIdToken).toHaveBeenCalledWith(
      '123456789-cookie-fluffs.apps.googleusercontent.com', 'nonce',
    );
    expect(auth.authenticateWithGoogle).toHaveBeenCalledWith('transient-id-token', 'selector', 'nonce');
    expect(nav.navigateRoot).toHaveBeenCalledWith('/home');
  });

  it('requests a signup-intent nonce after switching to the Sign Up tab', async () => {
    const component = page();
    component.ngAfterViewInit();
    await vi.waitFor(() => expect(component.googleEnabled()).toBe(true));
    component.setMode('signup');
    await component.startNativeGoogle();
    expect(auth.googleNonce).toHaveBeenLastCalledWith('signup');
  });

  it('shows sign-up guidance for an unregistered Google account on Login and creates no account', async () => {
    auth.authenticateWithGoogle.mockRejectedValue(new HttpErrorResponse({
      status: 409,
      error: {
        kind: 'signup_needed',
        message: 'No Cookie Fluffs account is linked to this Google account. Please sign up first.',
      },
    }));
    const component = page();
    component.ngAfterViewInit();
    await vi.waitFor(() => expect(component.googleEnabled()).toBe(true));
    await component.startNativeGoogle();

    expect(component.googleNotice()?.kind).toBe('signup_needed');
    expect(component.googlePending()).toBeNull();
    expect(nav.navigateRoot).not.toHaveBeenCalled();

    component.goToSignupFromNotice();
    expect(component.mode()).toBe('signup');
    expect(component.googleNotice()).toBeNull();

    // The next Google attempt on the Sign Up tab is bound to the signup intent.
    auth.authenticateWithGoogle.mockRejectedValueOnce(new HttpErrorResponse({
      status: 409,
      error: { kind: 'signup_required', selector: 's2', challenge: 'c2', profile: { email: 'x@y.z', firstName: 'X', lastName: 'Y' } },
    }));
    await component.startNativeGoogle();
    expect(auth.googleNonce).toHaveBeenLastCalledWith('signup');
  });

  it('guides an already-linked Google account to Login when chosen on Sign Up', async () => {
    auth.authenticateWithGoogle.mockRejectedValue(new HttpErrorResponse({
      status: 409,
      error: {
        kind: 'login_required',
        message: 'This Google account is already registered. Please log in instead.',
      },
    }));
    const component = page();
    component.ngAfterViewInit();
    await vi.waitFor(() => expect(component.googleEnabled()).toBe(true));
    component.setMode('signup');
    await component.startNativeGoogle();

    expect(component.googleNotice()?.kind).toBe('login_required');
    expect(nav.navigateRoot).not.toHaveBeenCalled();

    component.goToLoginFromNotice();
    expect(component.mode()).toBe('login');
    expect(component.googleNotice()).toBeNull();
  });

  it('completes Google signup with reviewed name, phone and consent', async () => {
    auth.completeGoogleSignup.mockResolvedValue({ fullName: 'Mara Santos', firstName: 'Mara' });
    const component = page();
    component.googlePending.set({
      kind: 'signup_required', selector: 'selector', challenge: 'challenge',
      profile: { email: 'mara@example.com', firstName: 'Mara', lastName: 'Santos' },
    });
    component.firstName = 'Mara';
    component.lastName = 'Santos';
    component.phone = '0917 123 4567';
    component.acceptedTerms = true;

    await component.completeGoogleSignup();

    expect(auth.completeGoogleSignup).toHaveBeenCalledWith(
      'selector', 'challenge', 'Mara', 'Santos', '0917 123 4567', true,
    );
    expect(nav.navigateRoot).toHaveBeenCalledWith('/home');
  });

  it('blocks Google signup completion when the reviewed name is invalid', async () => {
    const component = page();
    component.googlePending.set({
      kind: 'signup_required', selector: 'selector', challenge: 'challenge',
      profile: { email: 'mara@example.com', firstName: '', lastName: 'Santos' },
    });
    component.firstName = '';
    component.lastName = 'Santos';
    component.phone = '0917 123 4567';
    component.acceptedTerms = true;

    await component.completeGoogleSignup();

    expect(auth.completeGoogleSignup).not.toHaveBeenCalled();
    expect(component.googleError()).toBeTruthy();
  });

  it('shows explicit linking instead of silently linking a matching email', async () => {
    auth.authenticateWithGoogle.mockRejectedValue(new HttpErrorResponse({
      status: 409,
      error: {
        kind: 'link_required', selector: 'selector', challenge: 'challenge',
        message: 'Confirm your Cookie Fluffs password to link Google.',
      },
    }));
    const component = page();
    component.ngAfterViewInit();
    await vi.waitFor(() => expect(component.googleEnabled()).toBe(true));
    await component.startNativeGoogle();
    expect(component.googlePending()?.kind).toBe('link_required');
    expect(nav.navigateRoot).not.toHaveBeenCalled();
  });

  it('clears a consumed linking challenge and starts a fresh Google attempt', async () => {
    auth.authenticateWithGoogle.mockRejectedValueOnce(new HttpErrorResponse({
      status: 409,
      error: { kind: 'link_required', selector: 'selector', challenge: 'challenge' },
    }));
    auth.linkGoogleAccount.mockRejectedValueOnce(new HttpErrorResponse({
      status: 400,
      error: { code: 'google_link_restart_required' },
    }));
    const component = page();
    component.ngAfterViewInit();
    await vi.waitFor(() => expect(component.googleEnabled()).toBe(true));
    await component.startNativeGoogle();
    component.password = 'Wrong1!Cookie';
    await component.completeGoogleLink();

    expect(component.googlePending()).toBeNull();
    expect(component.password).toBe('');
    expect(component.googleError()).toBe(
      "We couldn't confirm your Cookie Fluffs password. Select Continue with Google to try again.",
    );

    auth.authenticateWithGoogle.mockResolvedValueOnce({ fullName: 'Mara Santos', firstName: 'Mara' });
    await component.startNativeGoogle();
    expect(auth.googleNonce).toHaveBeenCalledTimes(2);
    expect(nav.navigateRoot).toHaveBeenCalledWith('/home');
  });

  it('does not submit the same linking challenge twice while confirmation is pending', async () => {
    let resolveLink!: (user: { fullName: string; firstName: string }) => void;
    auth.linkGoogleAccount.mockReturnValueOnce(new Promise((resolve) => { resolveLink = resolve; }));
    const component = page();
    component.googlePending.set({ kind: 'link_required', selector: 'selector', challenge: 'challenge' });
    component.password = 'Existing1!Cookie';

    const first = component.completeGoogleLink();
    const duplicate = component.completeGoogleLink();
    expect(auth.linkGoogleAccount).toHaveBeenCalledOnce();
    resolveLink({ fullName: 'Mara Santos', firstName: 'Mara' });
    await Promise.all([first, duplicate]);
  });

  it('reloads the web lifecycle after a consumed challenge without reusing it', async () => {
    google.isNativeAndroid = false;
    auth.linkGoogleAccount.mockRejectedValueOnce(new HttpErrorResponse({
      status: 400,
      error: { code: 'google_link_restart_required' },
    }));
    const component = page();
    component.googlePending.set({ kind: 'link_required', selector: 'selector', challenge: 'challenge' });
    component.password = 'Wrong1!Cookie';

    await component.completeGoogleLink();

    expect(component.googlePending()).toBeNull();
    expect(component.password).toBe('');
    expect(google.restartWebPage).toHaveBeenCalledWith('link');
    expect(google.renderWebButton).not.toHaveBeenCalled();
  });

  it('persists the Sign Up tab in the URL before the GIS reload from the signup_needed notice', () => {
    const replaceState = vi.spyOn(history, 'replaceState').mockImplementation(() => undefined);
    try {
      google.isNativeAndroid = false;
      google.hasInitializedWebAttempt.mockReturnValue(true);
      const component = page();
      component.googleEnabled.set(true);
      component.googleNotice.set({ kind: 'signup_needed', message: 'No Cookie Fluffs account is linked.' });

      component.goToSignupFromNotice();

      // Mode switched to signup and the reload URL carries ?mode=signup (no secrets).
      expect(component.mode()).toBe('signup');
      expect(router.serializeUrl).toHaveBeenCalled();
      const reloadUrl = replaceState.mock.calls.at(-1)?.[2] as string;
      expect(reloadUrl).toContain('mode=signup');
      expect(reloadUrl).not.toMatch(/token|nonce|selector|challenge|password/i);
      expect(google.restartWebPage).toHaveBeenCalledWith(null);
    } finally {
      replaceState.mockRestore();
      google.hasInitializedWebAttempt.mockReturnValue(false);
    }
  });

  it('restores Sign Up mode when the page reloads with ?mode=signup and requests a signup nonce', async () => {
    google.isNativeAndroid = true;
    queryMode = 'signup';
    const component = page();
    component.ngAfterViewInit();
    await vi.waitFor(() => expect(component.googleEnabled()).toBe(true));

    // The selected tab is restored from the validated query param after a reload.
    expect(component.mode()).toBe('signup');

    // The next Google attempt is bound to signup; the old login nonce is never reused.
    await component.startNativeGoogle();
    expect(auth.googleNonce).toHaveBeenLastCalledWith('signup');
    expect(auth.googleNonce).not.toHaveBeenCalledWith('login');
  });

  it('falls back to Login for a missing or invalid mode parameter', async () => {
    google.isNativeAndroid = true;
    queryMode = 'administrator';
    const component = page();
    component.ngAfterViewInit();
    await vi.waitFor(() => expect(component.googleEnabled()).toBe(true));

    expect(component.mode()).toBe('login');
    await component.startNativeGoogle();
    expect(auth.googleNonce).toHaveBeenLastCalledWith('login');
  });

  it('switches back to Login from a login_required notice and issues no account-creating call', () => {
    const replaceState = vi.spyOn(history, 'replaceState').mockImplementation(() => undefined);
    try {
      google.isNativeAndroid = false;
      google.hasInitializedWebAttempt.mockReturnValue(true);
      const component = page();
      component.mode.set('signup');
      component.googleEnabled.set(true);
      component.googleNotice.set({ kind: 'login_required', message: 'Already registered.' });

      component.goToLoginFromNotice();

      expect(component.mode()).toBe('login');
      const reloadUrl = replaceState.mock.calls.at(-1)?.[2] as string;
      expect(reloadUrl).toContain('mode=login');
      // Switching tabs never authenticates or creates an account.
      expect(nav.navigateRoot).not.toHaveBeenCalled();
      expect(auth.completeGoogleSignup).not.toHaveBeenCalled();
      expect(auth.authenticateWithGoogle).not.toHaveBeenCalled();
    } finally {
      replaceState.mockRestore();
      google.hasInitializedWebAttempt.mockReturnValue(false);
    }
  });
});
