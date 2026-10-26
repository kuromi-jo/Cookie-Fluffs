/**
 * @file reset-password.page.spec.ts
 * @description In-memory link handling, password validation, and fresh-login result tests.
 */
import { TestBed } from '@angular/core/testing';
import { HttpErrorResponse } from '@angular/common/http';
import { ActivatedRoute } from '@angular/router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthService } from '../../core/auth.service';
import { ResetPasswordPage } from './reset-password.page';

describe('ResetPasswordPage', () => {
  const selector = 'cb811ba2-9458-4f3e-bc46-86a346448858';
  const token = 'a'.repeat(43);
  const auth = {
    passwordRecoveryConfig: vi.fn(async () => ({ enabled: true })),
    resetPassword: vi.fn(async () => 'Reset'),
  };
  const route = {
    snapshot: {
      queryParamMap: { get: vi.fn(() => selector) },
      fragment: `token=${token}` as string | null,
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    auth.passwordRecoveryConfig.mockResolvedValue({ enabled: true });
    route.snapshot.queryParamMap.get.mockReturnValue(selector);
    route.snapshot.fragment = `token=${token}`;
    TestBed.configureTestingModule({ providers: [
      { provide: AuthService, useValue: auth },
      { provide: ActivatedRoute, useValue: route },
    ] });
  });

  const page = () => TestBed.runInInjectionContext(() => new ResetPasswordPage());

  function enterValidPassword(component: ResetPasswordPage): void {
    component.newPassword = 'Fresh2!Password';
    component.confirmPassword = 'Fresh2!Password';
  }

  function apiError(status: number, message: string, errors?: Record<string, string>): HttpErrorResponse {
    return new HttpErrorResponse({ status, error: { message, ...(errors ? { errors } : {}) } });
  }

  it('captures the fragment in memory and removes it from browser history', async () => {
    const replace = vi.spyOn(history, 'replaceState');
    const storage = vi.spyOn(Storage.prototype, 'setItem');
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const component = page();
    await component.ionViewWillEnter();
    expect(component.linkValid()).toBe(true);
    expect(replace).toHaveBeenCalledWith(null, '', `${location.pathname}${location.search}`);
    expect(storage).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    replace.mockRestore();
    storage.mockRestore();
    log.mockRestore();
    error.mockRestore();
  });

  it.each([
    ['missing fragment', null],
    ['missing token prefix', token],
    ['short token', 'token=short'],
    ['malformed encoding', 'token=%E0%A4%A'],
  ])('rejects a %s without submitting', async (_label, fragment) => {
    route.snapshot.fragment = fragment;
    const component = page();
    await component.ionViewWillEnter();
    enterValidPassword(component);
    await component.submit();
    expect(component.linkValid()).toBe(false);
    expect(auth.resetPassword).not.toHaveBeenCalled();
  });

  it('rejects a malformed selector without submitting', async () => {
    route.snapshot.queryParamMap.get.mockReturnValue('not-a-selector');
    const component = page();
    await component.ionViewWillEnter();
    enterValidPassword(component);
    await component.submit();
    expect(component.linkValid()).toBe(false);
    expect(auth.resetPassword).not.toHaveBeenCalled();
  });

  it('shows disabled recovery and prevents submission', async () => {
    auth.passwordRecoveryConfig.mockResolvedValue({ enabled: false });
    const component = page();
    await component.ionViewWillEnter();
    enterValidPassword(component);
    await component.submit();
    expect(component.available()).toBe(false);
    expect(auth.resetPassword).not.toHaveBeenCalled();
  });

  it('shows HTTP 400 password validation details and retains the link for a corrected retry', async () => {
    const message = 'Password should not contain your name or email.';
    auth.resetPassword.mockRejectedValueOnce(apiError(400, message, { newPassword: message }));
    const component = page();
    await component.ionViewWillEnter();
    enterValidPassword(component);
    await component.submit();
    expect(component.pageError()).toBe(message);
    expect(component.errors().newPassword).toBe(message);
    expect(component.succeeded()).toBe(false);

    auth.resetPassword.mockResolvedValueOnce('Reset');
    await component.submit();
    expect(auth.resetPassword).toHaveBeenNthCalledWith(2, selector, token, 'Fresh2!Password');
    expect(component.succeeded()).toBe(true);
  });

  it('shows a safe HTTP 503 message and retains the link for retry', async () => {
    auth.resetPassword.mockRejectedValueOnce(apiError(503, 'Password recovery is not available.'));
    const component = page();
    await component.ionViewWillEnter();
    enterValidPassword(component);
    await component.submit();
    expect(component.pageError()).toBe('Cookie Fluffs is having trouble right now. Please try again in a moment.');
    expect(component.pageError()).not.toContain(token);
    expect(component.succeeded()).toBe(false);

    auth.resetPassword.mockResolvedValueOnce('Reset');
    await component.submit();
    expect(auth.resetPassword).toHaveBeenNthCalledWith(2, selector, token, 'Fresh2!Password');
  });

  it.each(['invalid', 'expired', 'already used'])('shows the safe API response for an %s token', async () => {
    const message = 'This recovery link is invalid or expired. Request a new one.';
    auth.resetPassword.mockRejectedValueOnce(apiError(400, message));
    const component = page();
    await component.ionViewWillEnter();
    enterValidPassword(component);
    await component.submit();
    expect(component.pageError()).toBe(message);
    expect(component.pageError()).not.toContain(token);
    expect(component.succeeded()).toBe(false);
  });

  it('shows local validation errors without calling the API', async () => {
    const component = page();
    await component.ionViewWillEnter();
    component.newPassword = 'weak';
    component.confirmPassword = 'different';
    await component.submit();
    expect(component.errors().newPassword).toBe('Password needs at least 8 characters.');
    expect(component.errors().confirmPassword).toBe('Passwords do not match.');
    expect(auth.resetPassword).not.toHaveBeenCalled();
  });

  it('consumes the token once and remains on the success state for explicit login navigation', async () => {
    const component = page();
    await component.ionViewWillEnter();
    enterValidPassword(component);
    await component.submit();
    expect(auth.resetPassword).toHaveBeenCalledWith(selector, token, 'Fresh2!Password');
    expect(component.succeeded()).toBe(true);
    expect(component.newPassword).toBe('');
    expect(component.confirmPassword).toBe('');
    await component.submit();
    expect(auth.resetPassword).toHaveBeenCalledTimes(1);
  });

  it('prevents duplicate submissions while the first request is pending', async () => {
    let finish!: (value: string) => void;
    auth.resetPassword.mockImplementationOnce(() => new Promise<string>((resolve) => { finish = resolve; }));
    const component = page();
    await component.ionViewWillEnter();
    enterValidPassword(component);
    const first = component.submit();
    await component.submit();
    expect(component.submitting()).toBe(true);
    expect(auth.resetPassword).toHaveBeenCalledTimes(1);
    finish('Reset');
    await first;
    expect(component.submitting()).toBe(false);
    expect(component.succeeded()).toBe(true);
  });

  it('clears the in-memory recovery secret when leaving the page', async () => {
    const component = page();
    await component.ionViewWillEnter();
    component.ionViewDidLeave();
    route.snapshot.fragment = null;
    await component.ionViewWillEnter();
    expect(component.linkValid()).toBe(false);
  });
});
