/**
 * @file favorite.service.spec.ts
 * @description Favorites loading, guest redirect, optimistic updates, and rollback tests.
 */
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Router } from '@angular/router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthService } from './auth.service';
import { FavoriteService } from './favorite.service';
import { Product, User } from './models';
import { UiService } from './ui.service';

const product = { id: 3, name: 'Choco Cloud', isAvailable: true } as Product;
const user = { id: 7 } as User;

describe('FavoriteService', () => {
  const currentUser = signal<User | null>(null);
  const auth = { user: currentUser, isLoggedIn: () => currentUser() !== null };
  const router = { url: '/shop', navigate: vi.fn(async () => true) };
  const ui = { toast: vi.fn(async () => undefined) };
  let service: FavoriteService;
  let http: HttpTestingController;

  beforeEach(() => {
    currentUser.set(null);
    vi.clearAllMocks();
    TestBed.configureTestingModule({ providers: [
      provideHttpClient(), provideHttpClientTesting(),
      { provide: AuthService, useValue: auth }, { provide: Router, useValue: router }, { provide: UiService, useValue: ui },
    ] });
    service = TestBed.inject(FavoriteService);
    http = TestBed.inject(HttpTestingController);
  });
  afterEach(() => http.verify());

  it('redirects a guest to login with the current destination', async () => {
    await service.toggle(product);
    expect(router.navigate).toHaveBeenCalledWith(['/login'], { queryParams: { returnUrl: '/shop' } });
  });

  it('loads persisted favorites after login and saves without duplicates', async () => {
    currentUser.set(user);
    TestBed.flushEffects();
    http.expectOne('/api/favorites').flush({ favorites: [] });
    await Promise.resolve();
    const save = service.toggle(product);
    expect(service.isFavorite(product.id)).toBe(true);
    const request = http.expectOne('/api/favorites/3');
    expect(request.request.method).toBe('PUT');
    expect(request.request.body).toEqual({});
    request.flush({ productId: 3, saved: true });
    await save;
    expect(service.favorites().filter((entry) => entry.id === 3)).toHaveLength(1);
  });

  it('rolls an optimistic change back when the API rejects it', async () => {
    currentUser.set(user);
    TestBed.flushEffects();
    http.expectOne('/api/favorites').flush({ favorites: [] });
    await Promise.resolve();
    const save = service.toggle(product);
    http.expectOne('/api/favorites/3').flush({ message: 'Unavailable.' }, { status: 409, statusText: 'Conflict' });
    await save;
    expect(service.isFavorite(product.id)).toBe(false);
    expect(ui.toast).toHaveBeenCalledWith(expect.any(String), { error: true });
  });
});
