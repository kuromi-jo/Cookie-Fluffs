/**
 * @file forgot-password.page.spec.ts
 * @description Recovery availability, validation, and generic-success UI tests.
 */
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthService } from '../../core/auth.service';
import { ForgotPasswordPage } from './forgot-password.page';

describe('ForgotPasswordPage', () => {
  const auth = {
    passwordRecoveryConfig: vi.fn(async () => ({ enabled: true })),
    requestPasswordReset: vi.fn(async () => 'Generic response'),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    auth.passwordRecoveryConfig.mockResolvedValue({ enabled: true });
    TestBed.configureTestingModule({ providers: [{ provide: AuthService, useValue: auth }] });
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

  it('validates email and shows the same generic completion state', async () => {
    const component = page();
    await component.ionViewWillEnter();
    component.email = 'invalid';
    await component.submit();
    expect(component.emailError()).toMatch(/valid email/i);
    component.email = 'customer@example.test';
    await component.submit();
    expect(auth.requestPasswordReset).toHaveBeenCalledWith('customer@example.test');
    expect(component.submitted()).toBe(true);
    expect(component.email).toBe('');
  });
});
