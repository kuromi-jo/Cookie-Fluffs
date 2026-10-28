/**
 * @file reset-password.page.spec.ts
 * @description Code entry: carried-over email, field validation, error handling that keeps input,
 * and the fresh-login result.
 */
import { TestBed } from '@angular/core/testing';
import { HttpErrorResponse } from '@angular/common/http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthService } from '../../core/auth.service';
import { ResetPasswordPage, validateResetCode } from './reset-password.page';

describe('ResetPasswordPage', () => {
  const auth = {
    passwordRecoveryConfig: vi.fn(async () => ({ enabled: true })),
    resetPassword: vi.fn(async () => 'Reset'),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    auth.passwordRecoveryConfig.mockResolvedValue({ enabled: true });
    auth.resetPassword.mockResolvedValue('Reset');
    TestBed.configureTestingModule({ providers: [{ provide: AuthService, useValue: auth }] });
  });

  afterEach(() => history.replaceState(null, ''));

  const page = () => TestBed.runInInjectionContext(() => new ResetPasswordPage());

  function fill(component: ResetPasswordPage): void {
    component.email = 'customer@example.test';
    component.code = '042917';
    component.newPassword = 'Fresh2!Password';
    component.confirmPassword = 'Fresh2!Password';
  }

  it('validates the 6-digit code', () => {
    expect(validateResetCode('')).toMatch(/6-digit code/);
    expect(validateResetCode('12345')).toMatch(/6 digits/);
    expect(validateResetCode('12a456')).toMatch(/6 digits/);
    expect(validateResetCode('042 917')).toBeNull();
  });

  it('uses the email carried over from the request step', async () => {
    history.replaceState({ email: 'customer@example.test' }, '');
    const component = page();
    await component.ionViewWillEnter();
    expect(component.email).toBe('customer@example.test');
    expect(component.emailFromRequest()).toBe(true);
  });

  it('shows field errors and does not submit an incomplete form', async () => {
    const component = page();
    await component.ionViewWillEnter();
    await component.submit();
    expect(auth.resetPassword).not.toHaveBeenCalled();
    expect(component.errors().email).toBeTruthy();
    expect(component.errors().code).toBeTruthy();
    expect(component.errors().newPassword).toBeTruthy();
  });

  it('resets with email, code and new password, then asks for a fresh login', async () => {
    const component = page();
    await component.ionViewWillEnter();
    fill(component);
    component.code = '042 917';
    await component.submit();
    expect(auth.resetPassword).toHaveBeenCalledWith('customer@example.test', '042917', 'Fresh2!Password');
    expect(component.succeeded()).toBe(true);
    expect(component.newPassword).toBe('');
  });

  it('keeps what was typed when the code is wrong', async () => {
    auth.resetPassword.mockRejectedValue(new HttpErrorResponse({
      status: 400,
      error: { message: 'That code is incorrect or has expired.', errors: { code: 'That code is incorrect or has expired.' } },
    }));
    const component = page();
    await component.ionViewWillEnter();
    fill(component);
    await component.submit();
    expect(component.succeeded()).toBe(false);
    expect(component.errors().code).toMatch(/incorrect/);
    expect(component.email).toBe('customer@example.test');
    expect(component.newPassword).toBe('Fresh2!Password');
  });
});
