/**
 * @file favorites.page.spec.ts
 * @description Favorites authentication, loading, and cart integration tests.
 */
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthService } from '../../core/auth.service';
import { CartService } from '../../core/cart.service';
import { FavoriteService } from '../../core/favorite.service';
import { Product } from '../../core/models';
import { ShopActionsService } from '../../core/shop-actions.service';
import { FavoritesPage } from './favorites.page';

describe('FavoritesPage', () => {
  const auth = { isLoggedIn: vi.fn(() => true) };
  const favorites = { load: vi.fn(async () => []), loading: () => false, loaded: () => true, error: () => '', favorites: () => [] };
  const cart = { quantityOf: vi.fn(() => 0), busy: () => new Set<number>() };
  const shop = { choosePack: vi.fn(async () => undefined) };
  const router = { navigate: vi.fn(async () => true) };

  beforeEach(() => {
    vi.clearAllMocks();
    auth.isLoggedIn.mockReturnValue(true);
    TestBed.configureTestingModule({ providers: [
      { provide: AuthService, useValue: auth }, { provide: FavoriteService, useValue: favorites },
      { provide: CartService, useValue: cart }, { provide: ShopActionsService, useValue: shop },
      { provide: Router, useValue: router },
    ] });
  });

  const page = () => TestBed.runInInjectionContext(() => new FavoritesPage());

  it('redirects guests while preserving the favorites destination', async () => {
    auth.isLoggedIn.mockReturnValue(false);
    await page().ionViewWillEnter();
    expect(router.navigate).toHaveBeenCalledWith(['/login'], {
      queryParams: { returnUrl: '/profile/favorites' }, replaceUrl: true,
    });
  });

  it('loads persisted favorites and adds only available products to the cart', async () => {
    const component = page();
    await component.ionViewWillEnter();
    expect(favorites.load).toHaveBeenCalledWith(true);
    component.addToCart({ id: 1, isAvailable: true } as Product);
    component.addToCart({ id: 2, isAvailable: false } as Product);
    expect(shop.choosePack).toHaveBeenCalledOnce();
    expect(shop.choosePack).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }));
  });
});
