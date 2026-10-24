/**
 * @file preference.service.spec.ts
 * @description Preference persistence, CSS application, and system motion tests.
 */
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthService } from './auth.service';
import { User } from './models';
import { PreferenceService, prefersReducedMotion } from './preference.service';

describe('PreferenceService', () => {
  const currentUser = signal<User | null>(null);
  const auth = { user: currentUser, isLoggedIn: () => currentUser() !== null };
  let service: PreferenceService;
  let http: HttpTestingController;

  beforeEach(() => {
    currentUser.set(null);
    document.documentElement.classList.remove('cf-reduce-motion', 'cf-larger-text');
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addEventListener: vi.fn() })));
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting(), { provide: AuthService, useValue: auth }] });
    service = TestBed.inject(PreferenceService);
    http = TestBed.inject(HttpTestingController);
  });
  afterEach(() => { http.verify(); vi.unstubAllGlobals(); });

  it('restores saved account settings and applies both root classes', async () => {
    currentUser.set({ id: 2 } as User);
    TestBed.flushEffects();
    http.expectOne('/api/preferences').flush({ reduceMotion: true, largerText: true, updatedAt: '2026-01-01' });
    await Promise.resolve();
    TestBed.flushEffects();
    expect(document.documentElement.classList.contains('cf-reduce-motion')).toBe(true);
    expect(document.documentElement.classList.contains('cf-larger-text')).toBe(true);
    expect(prefersReducedMotion()).toBe(true);
  });

  it('persists only the two approved preference values', async () => {
    const result = service.save({ reduceMotion: false, largerText: true });
    const request = http.expectOne('/api/preferences');
    expect(request.request.method).toBe('PUT');
    expect(request.request.body).toEqual({ reduceMotion: false, largerText: true });
    request.flush({ reduceMotion: false, largerText: true, updatedAt: '2026-01-02' });
    await result;
    TestBed.flushEffects();
    expect(document.documentElement.classList.contains('cf-larger-text')).toBe(true);
  });

  it('keeps reduced motion active when the operating system requests it', () => {
    service.preferences.set({ reduceMotion: false, largerText: false, updatedAt: null });
    service.systemReduceMotion.set(true);
    TestBed.flushEffects();
    expect(service.effectiveReduceMotion()).toBe(true);
    expect(document.documentElement.classList.contains('cf-reduce-motion')).toBe(true);
  });

  it('clears account-specific classes on logout', async () => {
    currentUser.set({ id: 2 } as User);
    TestBed.flushEffects();
    http.expectOne('/api/preferences').flush({ reduceMotion: true, largerText: true, updatedAt: null });
    await Promise.resolve();
    TestBed.flushEffects();
    currentUser.set(null);
    TestBed.flushEffects();
    expect(document.documentElement.classList.contains('cf-larger-text')).toBe(false);
  });
});
