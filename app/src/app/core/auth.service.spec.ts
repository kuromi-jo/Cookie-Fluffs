/**
 * @file auth.service.spec.ts
 * @description Authenticated profile API and local profile-state tests.
 */
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AuthService } from './auth.service';
import { User } from './models';

const user: User = {
  id: 1,
  fullName: 'Maria Santos',
  firstName: 'Maria',
  lastName: 'Santos',
  email: 'maria@example.test',
  phone: '+639171234567',
  avatar: null,
  createdAt: '2026-01-01T00:00:00.000Z',
};

describe('AuthService profile API', () => {
  let service: AuthService;
  let http: HttpTestingController;

  beforeEach(() => {
    localStorage.clear();
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
    service = TestBed.inject(AuthService);
    http = TestBed.inject(HttpTestingController);
    service.token.set('test-token');
  });

  afterEach(() => {
    http.verify();
    localStorage.clear();
  });

  it('refreshes the authenticated customer from GET /auth/me', async () => {
    const request = service.refreshProfile();
    http.expectOne('/api/auth/me').flush(user);
    await request;
    expect(service.user()).toEqual(user);
  });

  it('updates only approved profile fields and keeps returned state', async () => {
    const changes = { firstName: 'Mara', lastName: 'Santos', phone: '0918 765 4321' };
    const updated = { ...user, fullName: 'Mara Santos', firstName: 'Mara', phone: '+639187654321' };
    const request = service.updateProfile(changes);
    const api = http.expectOne('/api/auth/me');
    expect(api.request.method).toBe('PUT');
    expect(api.request.body).toEqual(changes);
    api.flush(updated);
    expect(await request).toEqual(updated);
    expect(service.user()).toEqual(updated);
  });

  it('replaces the revoked session token after a successful password change', async () => {
    const request = service.changePassword('Old1!Password', 'Fresh2!Password');
    const api = http.expectOne('/api/auth/change-password');
    expect(api.request.method).toBe('POST');
    expect(api.request.body).toEqual({ currentPassword: 'Old1!Password', newPassword: 'Fresh2!Password' });
    api.flush({ token: 'replacement-token', user });
    expect(await request).toEqual(user);
    expect(service.token()).toBe('replacement-token');
    expect(localStorage.getItem('cf.token')).toBe('replacement-token');
  });

  it('uses public recovery endpoints without changing the current session', async () => {
    const configRequest = service.passwordRecoveryConfig();
    http.expectOne('/api/auth/recovery-config').flush({ enabled: true });
    expect(await configRequest).toEqual({ enabled: true });

    const forgotRequest = service.requestPasswordReset('maria@example.test');
    const forgot = http.expectOne('/api/auth/forgot-password');
    expect(forgot.request.body).toEqual({ email: 'maria@example.test' });
    forgot.flush({ message: 'Check your email.' });
    expect(await forgotRequest).toBe('Check your email.');

    const resetRequest = service.resetPassword('selector', 'secret', 'Fresh2!Password');
    const reset = http.expectOne('/api/auth/reset-password');
    expect(reset.request.body).toEqual({ selector: 'selector', token: 'secret', newPassword: 'Fresh2!Password' });
    reset.flush({ message: 'Log in again.' });
    expect(await resetRequest).toBe('Log in again.');
    expect(service.token()).toBe('test-token');
  });

  it('keeps Google credentials transient and stores only the returned app session', async () => {
    const configRequest = service.googleAuthConfig();
    http.expectOne('/api/auth/google-config').flush({
      enabled: true,
      webClientId: '123456789-cookie-fluffs.apps.googleusercontent.com',
    });
    expect((await configRequest).enabled).toBe(true);

    const nonceRequest = service.googleNonce('login');
    const nonceApi = http.expectOne('/api/auth/google/nonce');
    expect(nonceApi.request.body).toEqual({ intent: 'login' });
    nonceApi.flush({ selector: 'nonce-selector', nonce: 'one-time-nonce' });
    expect(await nonceRequest).toEqual({ selector: 'nonce-selector', nonce: 'one-time-nonce' });

    const loginRequest = service.authenticateWithGoogle('transient-google-id-token', 'nonce-selector', 'one-time-nonce');
    const loginApi = http.expectOne('/api/auth/google/authenticate');
    expect(loginApi.request.body).toEqual({
      idToken: 'transient-google-id-token', selector: 'nonce-selector', nonce: 'one-time-nonce',
    });
    loginApi.flush({ token: 'cookie-fluffs-session', user });
    expect(await loginRequest).toEqual(user);
    expect(localStorage.getItem('cf.token')).toBe('cookie-fluffs-session');
    expect(JSON.stringify(localStorage)).not.toContain('transient-google-id-token');
  });

  it('completes Google signup and explicit password-confirmed linking', async () => {
    const signupRequest = service.completeGoogleSignup('selector', 'challenge', 'Mara', 'Santos', '0917 123 4567', true);
    const signupApi = http.expectOne('/api/auth/google/signup');
    expect(signupApi.request.body).toEqual({
      selector: 'selector', challenge: 'challenge',
      firstName: 'Mara', lastName: 'Santos', phone: '0917 123 4567', acceptedTerms: true,
    });
    signupApi.flush({ token: 'google-signup-session', user: { ...user, hasPassword: false } });
    expect((await signupRequest).hasPassword).toBe(false);

    const linkRequest = service.linkGoogleAccount('selector-2', 'challenge-2', 'Cookie1!Password');
    const linkApi = http.expectOne('/api/auth/google/link');
    expect(linkApi.request.body).toEqual({
      selector: 'selector-2', challenge: 'challenge-2', password: 'Cookie1!Password',
    });
    linkApi.flush({ token: 'google-link-session', user });
    expect(await linkRequest).toEqual(user);
  });
});
