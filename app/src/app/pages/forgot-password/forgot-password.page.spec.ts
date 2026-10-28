/**
 * @file forgot-password.page.spec.ts
 * @description Recovery availability, validation, and hand-off to the code screen.
 */
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthService } from '../../core/auth.service';
import { ForgotPasswordPage } from './forgot-password.page';

describe('ForgotPasswordPage', () => {
  const auth = {
    passwordRecoveryConfig: vi.fn(async () => ({ enabled: true })),
    requestPasswordReset: vi.fn(async () => 'Generic response'),
  };
  const router = { navigate: vi.fn(async () => true) };

  beforeEach(() => {
    vi.clearAllMocks();
    auth.passwordRecoveryConfig.mockResolvedValue({ enabled: true });
    TestBed.configureTestingModule({ providers: [
      { provide: AuthService, useValue: auth },
      { provide: Router, useValue: router },
    ] });
  });

  const page = () => TestBed.runInInjectionContext(() => new ForgotPasswordPage());

  it('shows disabled recovery honestly and does not submit', async () => {
    auth.passwordRecoveryConfig.mockResolvedValue({ enabled: false });
    const component = page();
    await component.ionViewWillEnter();
    component.email = 'customer@example.test';
    await component.submit();
    expect(component.available()).toBe(false);
    expect(auth.requestPasswordReset).not.toHaveBeenCalled();
  });

  it('validates email, requests a code and opens the code screen without putting the email in the URL', async () => {
    const component = page();
    await component.ionViewWillEnter();
    component.email = 'invalid';
    await component.submit();
    expect(component.emailError()).toMatch(/valid email/i);
    expect(auth.requestPasswordReset).not.toHaveBeenCalled();
    component.email = ' customer@example.test ';
    await component.submit();
    expect(auth.requestPasswordReset).toHaveBeenCalledWith('customer@example.test');
    expect(router.navigate).toHaveBeenCalledWith(['/reset-password'], { state: { email: 'customer@example.test' } });
  });
});
