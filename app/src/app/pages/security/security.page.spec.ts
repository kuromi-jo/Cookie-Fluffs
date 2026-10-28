/**
 * @file security.page.spec.ts
 * @description Password-form validation, session replacement, and guest redirect tests.
 */
import { HttpErrorResponse } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { ModalController } from '@ionic/angular';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthService } from '../../core/auth.service';
import { UiService } from '../../core/ui.service';
import { SecurityPage } from './security.page';

describe('SecurityPage', () => {
  const auth = {
    isLoggedIn: vi.fn(() => true),
    user: vi.fn(() => ({
      email: 'mara@example.test', firstName: 'Mara', lastName: 'Santos',
    })),
    changePassword: vi.fn(async () => ({})),
    accountStatus: vi.fn(async () => ({ hasPassword: true, google: { linked: false } })),
    logout: vi.fn(),
  };
  const router = { navigate: vi.fn(async () => true) };
  const ui = { toast: vi.fn(async () => undefined) };
  // The email-code sheet: verified by default, or closed when a test sets sheetResult.role = 'cancel'.
  let sheetResult: { role: string; data?: { challengeId: string } } = { role: 'verified', data: { challengeId: 'challenge-1' } };
  const modals = { create: vi.fn(async () => ({ present: async () => undefined, onDidDismiss: async () => sheetResult })) };

  beforeEach(() => {
    vi.clearAllMocks();
    auth.isLoggedIn.mockReturnValue(true);
    auth.changePassword.mockResolvedValue({});
    sheetResult = { role: 'verified', data: { challengeId: 'challenge-1' } };
    auth.accountStatus.mockResolvedValue({ hasPassword: true, google: { linked: false } });
    TestBed.configureTestingModule({ providers: [
      { provide: AuthService, useValue: auth },
      { provide: Router, useValue: router },
      { provide: UiService, useValue: ui },
      { provide: ModalController, useValue: modals },
    ] });
  });

  const page = () => TestBed.runInInjectionContext(() => new SecurityPage());

  it('validates all fields and replaces the current session through AuthService', async () => {
    const component = page();
    await component.submit();
    expect(component.fieldError('currentPassword')).toMatch(/current password/i);
    expect(component.fieldError('newPassword')).toMatch(/8 characters/i);

    component.currentPassword = 'Old1!Password';
    component.newPassword = 'Fresh2!Password';
    component.confirmPassword = 'Fresh2!Password';
    await component.submit();
    expect(modals.create).toHaveBeenCalledWith(expect.objectContaining({ componentProps: { operation: 'change_password' } }));
    expect(auth.changePassword).toHaveBeenCalledWith('Old1!Password', 'Fresh2!Password', 'challenge-1');
    expect(component.succeeded()).toBe(true);
    expect(component.currentPassword).toBe('');
    expect(ui.toast).toHaveBeenCalledWith('Password changed securely.', { icon: 'checkmark-circle' });
  });

  it('keeps input on validation failure and redirects revoked sessions to login', async () => {
    auth.changePassword.mockRejectedValue(new HttpErrorResponse({ status: 401, error: { message: 'Expired' } }));
    const component = page();
    component.currentPassword = 'Old1!Password';
    component.newPassword = 'Fresh2!Password';
    component.confirmPassword = 'Fresh2!Password';
    await component.submit();
    expect(auth.logout).toHaveBeenCalledOnce();
    expect(router.navigate).toHaveBeenCalledWith(['/login'], {
      queryParams: { returnUrl: '/profile/security' }, replaceUrl: true,
    });
  });

  it('does not change the password when the email-code sheet is closed', async () => {
    sheetResult = { role: 'cancel' };
    const component = page();
    component.currentPassword = 'Old1!Password';
    component.newPassword = 'Fresh2!Password';
    component.confirmPassword = 'Fresh2!Password';
    await component.submit();
    expect(modals.create).toHaveBeenCalledOnce();
    expect(auth.changePassword).not.toHaveBeenCalled();
    expect(component.newPassword).toBe('Fresh2!Password');
  });

  it('redirects guests before showing account security', async () => {
    auth.isLoggedIn.mockReturnValue(false);
    await page().ionViewWillEnter();
    expect(router.navigate).toHaveBeenCalledWith(['/login'], {
      queryParams: { returnUrl: '/profile/security' }, replaceUrl: true,
    });
    expect(auth.accountStatus).not.toHaveBeenCalled();
  });

  it('loads the read-only sign-in methods on entry', async () => {
    auth.accountStatus.mockResolvedValue({ hasPassword: true, google: { linked: true } });
    const component = page();
    await component.ionViewWillEnter();
    expect(auth.accountStatus).toHaveBeenCalledOnce();
    expect(component.accountStatus()).toEqual({ hasPassword: true, google: { linked: true } });
  });

  it('hides the sign-in methods panel when the status read fails, without blocking password change', async () => {
    auth.accountStatus.mockRejectedValue(new Error('offline'));
    const component = page();
    await component.ionViewWillEnter();
    expect(component.accountStatus()).toBeNull();
  });
});
