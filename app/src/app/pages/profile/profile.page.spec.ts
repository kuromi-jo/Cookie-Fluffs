/**
 * @file profile.page.spec.ts
 * @description Profile validation, editing, persistence, and authentication redirect tests.
 */
import { signal } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { AlertController, ModalController } from '@ionic/angular';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthService } from '../../core/auth.service';
import { GoogleAuthService } from '../../core/google-auth.service';
import { VerificationService } from '../../core/verification.service';
import { NotificationService } from '../../core/notification.service';
import { User } from '../../core/models';
import { UiService } from '../../core/ui.service';
import { ProfilePage, profileDraft, validateProfile } from './profile.page';
import { Router } from '@angular/router';

const initialUser: User = {
  id: 1,
  fullName: 'Maria Santos',
  firstName: 'Maria',
  lastName: 'Santos',
  email: 'maria@example.test',
  phone: '+639171234567',
  avatar: null,
  gender: null,
  dateOfBirth: null,
  createdAt: '2026-01-01T00:00:00.000Z',
};

describe('ProfilePage', () => {
  const currentUser = signal<User | null>(initialUser);
  const auth = {
    user: currentUser,
    isLoggedIn: () => currentUser() !== null,
    refreshProfile: vi.fn(async () => undefined),
    updateProfile: vi.fn(async (changes: Partial<User>) => {
      const updated = {
        ...(currentUser() as User),
        ...changes,
        fullName: `${changes.firstName} ${changes.lastName}`,
      };
      currentUser.set(updated);
      return updated;
    }),
    logout: vi.fn(),
    changePhone: vi.fn(async () => ({ ...(currentUser() as User), phone: '+639188887777' })),
    reauthPassword: vi.fn(async () => 'proof-pw'),
    reauthGoogle: vi.fn(async () => 'proof-google'),
    changeEmail: vi.fn(async () => ({ ...(currentUser() as User), email: 'new@example.test' })),
    setPassword: vi.fn(async () => ({ ...(currentUser() as User), hasPassword: true })),
    googleAuthConfig: vi.fn(async () => ({ enabled: true, webClientId: 'client-id' })),
    googleNonce: vi.fn(async () => ({ selector: 'sel', nonce: 'non' })),
  };
  const router = { navigate: vi.fn(async () => true), navigateByUrl: vi.fn(async () => true) };
  const ui = { toast: vi.fn(async () => undefined) };
  const alerts = { create: vi.fn() };
  const modals = { create: vi.fn() };
  const notifications = { refreshUnread: vi.fn(async () => undefined), unread: signal(0), unreadStale: signal(false), hasUnread: signal(false) };
  const google = { isNativeAndroid: false, nativeIdToken: vi.fn(async () => 'google-id-token') };
  const verification = { googleReauthNonce: vi.fn(async () => ({ selector: 'sel-r', nonce: 'non-r' })) };

  beforeEach(() => {
    currentUser.set(initialUser);
    google.isNativeAndroid = false;
    vi.clearAllMocks();
    TestBed.configureTestingModule({
      providers: [
        { provide: AuthService, useValue: auth },
        { provide: Router, useValue: router },
        { provide: UiService, useValue: ui },
        { provide: AlertController, useValue: alerts },
        { provide: ModalController, useValue: modals },
        { provide: NotificationService, useValue: notifications },
        { provide: GoogleAuthService, useValue: google },
        { provide: VerificationService, useValue: verification },
      ],
    });
  });

  function page(): ProfilePage {
    return TestBed.runInInjectionContext(() => new ProfilePage());
  }

  it('maps authenticated profile data and validates names and Philippine phones', () => {
    expect(profileDraft(initialUser)).toEqual({
      firstName: 'Maria', lastName: 'Santos', avatar: null, gender: null, dateOfBirth: null,
    });
    expect(validateProfile({ firstName: 'M', lastName: '', avatar: null, gender: null, dateOfBirth: null }))
      .toEqual(expect.objectContaining({ firstName: expect.any(String), lastName: expect.any(String) }));
  });

  it('cancels edits without changing the authenticated profile', () => {
    const component = page();
    component.startEditing();
    component.update('firstName', 'Changed');
    component.cancelEditing();
    expect(component.editing()).toBe(false);
    expect(component.draft().firstName).toBe('Maria');
    expect(currentUser()?.firstName).toBe('Maria');
  });

  it('saves approved personal information and updates displayed profile state', async () => {
    const component = page();
    component.startEditing();
    component.update('firstName', 'Mara');
    component.update('lastName', 'Reyes');
    await component.save();
    expect(auth.updateProfile).toHaveBeenCalledWith({
      firstName: 'Mara', lastName: 'Reyes', gender: null, dateOfBirth: null,
    });
    expect(component.editing()).toBe(false);
    expect(currentUser()?.fullName).toBe('Mara Reyes');
    expect(ui.toast).toHaveBeenCalledWith('Personal information updated.', { icon: 'checkmark-circle' });
  });

  it('disables saving until the edit form differs from the saved profile', () => {
    const component = page();
    component.startEditing();
    expect(component.hasChanges()).toBe(false);
    component.update('firstName', 'Mara');
    expect(component.hasChanges()).toBe(true);
    component.update('firstName', 'Maria');
    expect(component.hasChanges()).toBe(false);
  });

  it('removes the profile photo and persists the cleared avatar on save', async () => {
    currentUser.set({ ...initialUser, avatar: 'data:image/jpeg;base64,Zm9v' });
    const component = page();
    component.startEditing();
    expect(component.draft().avatar).toBe('data:image/jpeg;base64,Zm9v');
    component.removePhoto();
    expect(component.draft().avatar).toBeNull();
    expect(component.hasChanges()).toBe(true);
    await component.save();
    expect(auth.updateProfile).toHaveBeenCalledWith(expect.objectContaining({ avatar: null }));
  });

  it('saves optional gender and date of birth', async () => {
    const component = page();
    component.startEditing();
    component.setGender('non_binary');
    component.setDateOfBirth('1998-05-20');
    expect(component.hasChanges()).toBe(true);
    await component.save();
    expect(auth.updateProfile).toHaveBeenCalledWith(expect.objectContaining({
      gender: 'non_binary', dateOfBirth: '1998-05-20',
    }));
  });

  it('clears optional gender and date of birth back to null', async () => {
    currentUser.set({ ...initialUser, gender: 'female', dateOfBirth: '1990-01-01' });
    const component = page();
    component.startEditing();
    expect(component.draft().gender).toBe('female');
    component.setGender(null);
    component.clearDateOfBirth();
    expect(component.draft().dateOfBirth).toBeNull();
    await component.save();
    expect(auth.updateProfile).toHaveBeenCalledWith(expect.objectContaining({ gender: null, dateOfBirth: null }));
  });

  it('rejects a future or invalid date of birth before saving', async () => {
    const component = page();
    component.startEditing();
    const nextYear = `${new Date().getUTCFullYear() + 1}-01-01`;
    component.setDateOfBirth(nextYear);
    await component.save();
    expect(auth.updateProfile).not.toHaveBeenCalled();
    expect(component.fieldError('dateOfBirth')).toContain('future');

    component.setDateOfBirth('2020-02-30'); // impossible calendar date
    await component.save();
    expect(auth.updateProfile).not.toHaveBeenCalled();
    expect(component.fieldError('dateOfBirth')).toBeTruthy();
  });

  it('does not send invalid profile edits', async () => {
    const component = page();
    component.startEditing();
    component.update('firstName', 'M'); // too short
    await component.save();
    expect(auth.updateProfile).not.toHaveBeenCalled();
    expect(component.fieldError('firstName')).toBeTruthy();
  });

  it('masks the protected phone number for display', () => {
    const component = page();
    expect(component.maskedPhone('+639171234567')).toMatch(/^\+6391.*4567$/);
    expect(component.maskedPhone('+639171234567')).not.toContain('7123');
  });

  // Helpers for the two-alert Change Phone flow: a number prompt then a final confirmation.
  function mockNumberPrompt(phone: string) {
    alerts.create.mockResolvedValueOnce({
      present: vi.fn(async () => undefined),
      onDidDismiss: async () => ({ role: 'confirm', data: { values: { phone } } }),
    });
  }
  function mockVerificationModal(result: { role: string; data?: { challengeId: string } }) {
    modals.create.mockResolvedValueOnce({
      present: vi.fn(async () => undefined),
      onDidDismiss: async () => result,
    });
  }
  function mockConfirmDialog(role: 'confirm' | 'cancel' | 'backdrop') {
    alerts.create.mockResolvedValueOnce({
      present: vi.fn(async () => undefined),
      onDidDismiss: async () => ({ role }),
    });
  }

  it('applies the verified Change Phone only after an explicit final confirmation', async () => {
    mockNumberPrompt('0918 888 7777');
    mockVerificationModal({ role: 'verified', data: { challengeId: 'chal-xyz' } });
    mockConfirmDialog('confirm');
    const component = page();
    await component.startChangePhone();
    // The same normalized number is used for the change (matches the verification target).
    expect(auth.changePhone).toHaveBeenCalledWith('chal-xyz', '+639188887777');
    expect(auth.changePhone).toHaveBeenCalledTimes(1);
    expect(notifications.refreshUnread).toHaveBeenCalledOnce();
    expect(ui.toast).toHaveBeenCalledWith('Mobile number updated.', { icon: 'checkmark-circle' });
    // The confirmation dialog shows masked current and proposed numbers (no OTP).
    const confirmOptions = alerts.create.mock.calls[1][0];
    expect(confirmOptions.message).toMatch(/\+6391.*4567/); // masked current
    expect(confirmOptions.message).toMatch(/\+6391.*7777/); // masked proposed
    expect(confirmOptions.message).toContain('does not prove you own');
  });

  it('does NOT change the phone when a challenge is verified but confirmation is not accepted', async () => {
    mockNumberPrompt('0918 888 7777');
    mockVerificationModal({ role: 'verified', data: { challengeId: 'chal-xyz' } });
    mockConfirmDialog('cancel');
    const component = page();
    await component.startChangePhone();
    expect(auth.changePhone).not.toHaveBeenCalled();
    expect(ui.toast).not.toHaveBeenCalledWith('Mobile number updated.', { icon: 'checkmark-circle' });
  });

  it('does NOT change the phone when the confirmation is dismissed by backdrop/back', async () => {
    mockNumberPrompt('0918 888 7777');
    mockVerificationModal({ role: 'verified', data: { challengeId: 'chal-xyz' } });
    mockConfirmDialog('backdrop');
    const component = page();
    await component.startChangePhone();
    expect(auth.changePhone).not.toHaveBeenCalled();
  });

  it('does NOT change the phone when identity verification is cancelled', async () => {
    mockNumberPrompt('0918 888 7777');
    mockVerificationModal({ role: 'cancel' });
    const component = page();
    await component.startChangePhone();
    expect(auth.changePhone).not.toHaveBeenCalled();
    // No confirmation dialog is shown when verification did not succeed.
    expect(alerts.create).toHaveBeenCalledTimes(1);
  });

  it('shows the Verify Again message when the authorization expired before confirmation', async () => {
    auth.changePhone.mockRejectedValueOnce(
      new HttpErrorResponse({ status: 409, error: { message: 'Verify your identity again to change your number.' } }),
    );
    mockNumberPrompt('0918 888 7777');
    mockVerificationModal({ role: 'verified', data: { challengeId: 'chal-xyz' } });
    mockConfirmDialog('confirm');
    const component = page();
    await component.startChangePhone();
    expect(auth.changePhone).toHaveBeenCalledOnce();
    expect(component.pageError()).toContain('Verify your identity again');
    expect(ui.toast).toHaveBeenCalledWith('Verify your identity again to change your number.', { error: true });
    expect(component.changingPhone()).toBe(false); // flag released after failure
  });

  it('ignores a re-entrant confirm while a change request is already pending', async () => {
    const component = page();
    component.changingPhone.set(true); // simulate an in-flight request
    await component['confirmAndApplyPhoneChange']('chal-xyz', '+639188887777');
    expect(alerts.create).not.toHaveBeenCalled(); // no confirmation dialog, no API call
    expect(auth.changePhone).not.toHaveBeenCalled();
    component.changingPhone.set(false);
  });

  it('masks the current and proposed numbers correctly in the confirmation copy', async () => {
    mockNumberPrompt('0918 888 7777');
    mockVerificationModal({ role: 'verified', data: { challengeId: 'chal-xyz' } });
    mockConfirmDialog('confirm');
    const component = page();
    await component.startChangePhone();
    const msg = alerts.create.mock.calls[1][0].message as string;
    expect(msg).not.toContain('1234567'); // raw current digits never shown
    expect(msg).not.toContain('8887777'); // raw proposed digits never shown
  });

  it('rejects an invalid new phone number before verifying', async () => {
    alerts.create.mockResolvedValueOnce({
      present: vi.fn(async () => undefined),
      onDidDismiss: async () => ({ role: 'confirm', data: { values: { phone: '123' } } }),
    });
    const component = page();
    await component.startChangePhone();
    expect(modals.create).not.toHaveBeenCalled();
    expect(auth.changePhone).not.toHaveBeenCalled();
    expect(ui.toast).toHaveBeenCalledWith(expect.stringContaining('Philippine mobile number'), { error: true });
  });

  it('redirects guests to login with the profile return URL', async () => {
    currentUser.set(null);
    await page().ionViewWillEnter();
    expect(router.navigate).toHaveBeenCalledWith(['/login'], {
      queryParams: { returnUrl: '/profile' }, replaceUrl: true,
    });
  });

  it('clears an expired session and returns to login', async () => {
    auth.refreshProfile.mockRejectedValueOnce(new HttpErrorResponse({ status: 401 }));
    await page().ionViewWillEnter();
    expect(auth.logout).toHaveBeenCalledOnce();
    expect(router.navigate).toHaveBeenCalledWith(['/login'], {
      queryParams: { returnUrl: '/profile' }, replaceUrl: true,
    });
  });

  // --- Change Email flow (new-email prompt -> password reauth -> OTP -> confirm) ---
  function mockEmailPrompt(email: string) {
    alerts.create.mockResolvedValueOnce({
      present: vi.fn(async () => undefined),
      onDidDismiss: async () => ({ role: 'confirm', data: { values: { email } } }),
    });
  }
  function mockPasswordReauth(role: 'confirm' | 'cancel', password = 'Secret1!Cookie') {
    alerts.create.mockResolvedValueOnce({
      present: vi.fn(async () => undefined),
      onDidDismiss: async () => ({ role, data: { values: { password } } }),
    });
  }

  it('changes the email only after reauth, OTP verification, and explicit confirmation', async () => {
    mockEmailPrompt('New@Example.test');
    mockPasswordReauth('confirm');
    mockVerificationModal({ role: 'verified', data: { challengeId: 'chal-e' } });
    mockConfirmDialog('confirm');
    const component = page();
    await component.startChangeEmail();
    expect(auth.reauthPassword).toHaveBeenCalledWith('Secret1!Cookie');
    expect(modals.create).toHaveBeenCalledWith(expect.objectContaining({
      componentProps: { operation: 'change_email', target: 'new@example.test' },
    }));
    expect(auth.changeEmail).toHaveBeenCalledWith('proof-pw', 'chal-e', 'new@example.test');
    expect(auth.changeEmail).toHaveBeenCalledTimes(1);
    expect(notifications.refreshUnread).toHaveBeenCalledOnce();
    expect(ui.toast).toHaveBeenCalledWith('Email address updated.', { icon: 'checkmark-circle' });
    const confirmMsg = alerts.create.mock.calls[2][0].message as string;
    expect(confirmMsg).toMatch(/m.*@example\.test/);
    expect(confirmMsg).toMatch(/n.*@example\.test/);
    expect(confirmMsg).toContain('use the new email to log in');
  });

  it('does NOT change the email when reauthentication is cancelled', async () => {
    mockEmailPrompt('new@example.test');
    mockPasswordReauth('cancel');
    const component = page();
    await component.startChangeEmail();
    expect(auth.reauthPassword).not.toHaveBeenCalled();
    expect(modals.create).not.toHaveBeenCalled();
    expect(auth.changeEmail).not.toHaveBeenCalled();
  });

  it('does NOT change the email when the OTP step is cancelled', async () => {
    mockEmailPrompt('new@example.test');
    mockPasswordReauth('confirm');
    mockVerificationModal({ role: 'cancel' });
    const component = page();
    await component.startChangeEmail();
    expect(auth.reauthPassword).toHaveBeenCalledOnce();
    expect(auth.changeEmail).not.toHaveBeenCalled();
  });

  it('does NOT change the email when the final confirmation is cancelled', async () => {
    mockEmailPrompt('new@example.test');
    mockPasswordReauth('confirm');
    mockVerificationModal({ role: 'verified', data: { challengeId: 'chal-e' } });
    mockConfirmDialog('cancel');
    const component = page();
    await component.startChangeEmail();
    expect(auth.changeEmail).not.toHaveBeenCalled();
  });

  it('rejects an invalid new email before reauthenticating', async () => {
    mockEmailPrompt('not-an-email');
    const component = page();
    await component.startChangeEmail();
    expect(auth.reauthPassword).not.toHaveBeenCalled();
    expect(ui.toast).toHaveBeenCalledWith(expect.stringContaining('valid email'), { error: true });
  });

  it('rejects changing to the current email address', async () => {
    mockEmailPrompt('maria@example.test');
    const component = page();
    await component.startChangeEmail();
    expect(auth.reauthPassword).not.toHaveBeenCalled();
    expect(ui.toast).toHaveBeenCalledWith(expect.stringContaining('already your email'), { error: true });
  });

  it('reauthenticates a Google-only account on WEB via the GIS modal and a purpose-bound nonce', async () => {
    google.isNativeAndroid = false;
    currentUser.set({ ...initialUser, hasPassword: false });
    mockEmailPrompt('new@example.test');
    // Web path opens the Google reauth modal, which resolves with a fresh id token.
    modals.create.mockResolvedValueOnce({
      present: vi.fn(async () => undefined),
      onDidDismiss: async () => ({ role: 'reauthed', data: 'web-id-token' }),
    });
    mockVerificationModal({ role: 'verified', data: { challengeId: 'chal-e' } });
    mockConfirmDialog('confirm');
    const component = page();
    await component.startChangeEmail();
    expect(auth.reauthPassword).not.toHaveBeenCalled();
    expect(verification.googleReauthNonce).toHaveBeenCalledOnce(); // purpose-bound reauth nonce, not login
    expect(auth.googleNonce).not.toHaveBeenCalled(); // never the login/signup nonce
    expect(google.nativeIdToken).not.toHaveBeenCalled(); // web does not use the native plugin
    expect(auth.reauthGoogle).toHaveBeenCalledWith('sel-r', 'non-r', 'web-id-token', 'change_email');
    expect(auth.changeEmail).toHaveBeenCalledWith('proof-google', 'chal-e', 'new@example.test');
  });

  it('reauthenticates a Google-only account on ANDROID via the native plugin', async () => {
    google.isNativeAndroid = true;
    currentUser.set({ ...initialUser, hasPassword: false });
    mockEmailPrompt('new@example.test');
    mockVerificationModal({ role: 'verified', data: { challengeId: 'chal-e' } });
    mockConfirmDialog('confirm');
    const component = page();
    await component.startChangeEmail();
    expect(verification.googleReauthNonce).toHaveBeenCalledOnce();
    expect(google.nativeIdToken).toHaveBeenCalledWith('client-id', 'non-r');
    expect(auth.reauthGoogle).toHaveBeenCalledWith('sel-r', 'non-r', 'google-id-token', 'change_email');
    expect(auth.changeEmail).toHaveBeenCalledWith('proof-google', 'chal-e', 'new@example.test');
    google.isNativeAndroid = false;
  });

  it('does NOT change the email when the web Google reauth modal is cancelled', async () => {
    google.isNativeAndroid = false;
    currentUser.set({ ...initialUser, hasPassword: false });
    mockEmailPrompt('new@example.test');
    modals.create.mockResolvedValueOnce({
      present: vi.fn(async () => undefined),
      onDidDismiss: async () => ({ role: 'cancel', data: null }),
    });
    const component = page();
    await component.startChangeEmail();
    expect(auth.reauthGoogle).not.toHaveBeenCalled();
    expect(auth.changeEmail).not.toHaveBeenCalled();
  });

  it('surfaces a duplicate-email error from the change endpoint', async () => {
    auth.changeEmail.mockRejectedValueOnce(
      new HttpErrorResponse({ status: 409, error: { message: 'That email already has an account. Try another.' } }),
    );
    mockEmailPrompt('new@example.test');
    mockPasswordReauth('confirm');
    mockVerificationModal({ role: 'verified', data: { challengeId: 'chal-e' } });
    mockConfirmDialog('confirm');
    const component = page();
    await component.startChangeEmail();
    expect(component.pageError()).toContain('already has an account');
    expect(component.changingEmail()).toBe(false);
  });

  it('ignores a re-entrant email confirm while a change is pending', async () => {
    const component = page();
    component.changingEmail.set(true);
    await component['confirmAndApplyEmailChange']('proof', 'chal', 'new@example.test');
    expect(alerts.create).not.toHaveBeenCalled();
    expect(auth.changeEmail).not.toHaveBeenCalled();
    component.changingEmail.set(false);
  });

  it('masks the email so the full local part is never shown', () => {
    const component = page();
    expect(component.maskedEmail('maria@example.test')).toMatch(/^m.*@example\.test$/);
    expect(component.maskedEmail('maria@example.test')).not.toContain('maria');
  });

  // --- Set Password flow (Google reauth modal -> set_password OTP -> password prompt -> confirm) ---
  function mockGoogleReauthModal(role: 'reauthed' | 'cancel', data: string | null = 'web-id-token') {
    modals.create.mockResolvedValueOnce({
      present: vi.fn(async () => undefined),
      onDidDismiss: async () => ({ role, data }),
    });
  }
  function mockPasswordPrompt(role: 'confirm' | 'cancel', password = 'Cookie1!Secret', confirm = 'Cookie1!Secret') {
    alerts.create.mockResolvedValueOnce({
      present: vi.fn(async () => undefined),
      onDidDismiss: async () => ({ role, data: { values: { password, confirm } } }),
    });
  }

  it('sets a first password for a Google-only account after reauth, OTP, and confirmation (web)', async () => {
    google.isNativeAndroid = false;
    currentUser.set({ ...initialUser, hasPassword: false });
    mockGoogleReauthModal('reauthed');             // Google step-up
    mockVerificationModal({ role: 'verified', data: { challengeId: 'chal-sp' } }); // set_password OTP
    mockPasswordPrompt('confirm');                 // new + confirm password
    mockConfirmDialog('confirm');                  // final confirmation
    const component = page();
    await component.startSetPassword();
    expect(verification.googleReauthNonce).toHaveBeenCalledOnce();
    expect(auth.reauthGoogle).toHaveBeenCalledWith('sel-r', 'non-r', 'web-id-token', 'set_password');
    expect(modals.create).toHaveBeenCalledWith(expect.objectContaining({
      componentProps: { operation: 'set_password', target: null },
    }));
    expect(auth.setPassword).toHaveBeenCalledWith('proof-google', 'chal-sp', 'Cookie1!Secret');
    expect(auth.setPassword).toHaveBeenCalledTimes(1);
    expect(notifications.refreshUnread).toHaveBeenCalledOnce();
    expect(ui.toast).toHaveBeenCalledWith('Password set.', { icon: 'checkmark-circle' });
  });

  it('does not expose Set Password for an account that already has a password', () => {
    currentUser.set({ ...initialUser, hasPassword: true });
    expect(page().canSetPassword()).toBe(false);
  });

  it('refuses Set Password when the account already has a password (guard)', async () => {
    currentUser.set({ ...initialUser, hasPassword: true });
    const component = page();
    await component.startSetPassword();
    expect(verification.googleReauthNonce).not.toHaveBeenCalled();
    expect(auth.setPassword).not.toHaveBeenCalled();
  });

  it('does NOT set a password when Google reauthentication is cancelled', async () => {
    google.isNativeAndroid = false;
    currentUser.set({ ...initialUser, hasPassword: false });
    mockGoogleReauthModal('cancel', null);
    const component = page();
    await component.startSetPassword();
    expect(auth.reauthGoogle).not.toHaveBeenCalled();
    expect(auth.setPassword).not.toHaveBeenCalled();
  });

  it('does NOT set a password when the OTP step is cancelled', async () => {
    google.isNativeAndroid = false;
    currentUser.set({ ...initialUser, hasPassword: false });
    mockGoogleReauthModal('reauthed');
    mockVerificationModal({ role: 'cancel' });
    const component = page();
    await component.startSetPassword();
    expect(auth.reauthGoogle).toHaveBeenCalledOnce();
    expect(auth.setPassword).not.toHaveBeenCalled();
  });

  it('rejects mismatched passwords before the final confirmation', async () => {
    google.isNativeAndroid = false;
    currentUser.set({ ...initialUser, hasPassword: false });
    mockGoogleReauthModal('reauthed');
    mockVerificationModal({ role: 'verified', data: { challengeId: 'chal-sp' } });
    mockPasswordPrompt('confirm', 'Cookie1!Secret', 'Different1!');
    const component = page();
    await component.startSetPassword();
    expect(auth.setPassword).not.toHaveBeenCalled();
    expect(ui.toast).toHaveBeenCalledWith(expect.stringContaining('don\u2019t match'), { error: true });
  });

  it('rejects a too-short password before the final confirmation', async () => {
    google.isNativeAndroid = false;
    currentUser.set({ ...initialUser, hasPassword: false });
    mockGoogleReauthModal('reauthed');
    mockVerificationModal({ role: 'verified', data: { challengeId: 'chal-sp' } });
    mockPasswordPrompt('confirm', 'short', 'short');
    const component = page();
    await component.startSetPassword();
    expect(auth.setPassword).not.toHaveBeenCalled();
    expect(ui.toast).toHaveBeenCalledWith(expect.stringContaining('8 to 64'), { error: true });
  });

  it('does NOT set a password when the final confirmation is cancelled', async () => {
    google.isNativeAndroid = false;
    currentUser.set({ ...initialUser, hasPassword: false });
    mockGoogleReauthModal('reauthed');
    mockVerificationModal({ role: 'verified', data: { challengeId: 'chal-sp' } });
    mockPasswordPrompt('confirm');
    mockConfirmDialog('cancel');
    const component = page();
    await component.startSetPassword();
    expect(auth.setPassword).not.toHaveBeenCalled();
  });

  it('surfaces a password-exists conflict from the endpoint', async () => {
    google.isNativeAndroid = false;
    currentUser.set({ ...initialUser, hasPassword: false });
    auth.setPassword.mockRejectedValueOnce(
      new HttpErrorResponse({ status: 409, error: { message: 'This account already has a password. Use Change password instead.' } }),
    );
    mockGoogleReauthModal('reauthed');
    mockVerificationModal({ role: 'verified', data: { challengeId: 'chal-sp' } });
    mockPasswordPrompt('confirm');
    mockConfirmDialog('confirm');
    const component = page();
    await component.startSetPassword();
    expect(component.pageError()).toContain('already has a password');
    expect(component.settingPassword()).toBe(false);
  });

  it('preserves the confirmed logout behavior', async () => {
    const present = vi.fn(async () => undefined);
    alerts.create.mockResolvedValueOnce({ present });
    await page().confirmLogout();
    const options = alerts.create.mock.calls[0][0];
    const logoutButton = options.buttons[1];
    logoutButton.handler();
    expect(present).toHaveBeenCalledOnce();
    expect(auth.logout).toHaveBeenCalledOnce();
    expect(router.navigateByUrl).toHaveBeenCalledWith('/home');
  });
});
