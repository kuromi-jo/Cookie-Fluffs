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
});
