/**
 * @file tabs.page.spec.ts
 * @description Five-tab active-state mapping for browsing and nested customer routes.
 */
import { describe, expect, it } from 'vitest';
import { navigationTabForPath } from './tabs.page';

describe('five-tab navigation', () => {
  it('maps primary destinations to their matching tabs', () => {
    expect(navigationTabForPath('/home')).toBe('home');
    expect(navigationTabForPath('/shop')).toBe('shop');
    expect(navigationTabForPath('/profile/favorites')).toBe('favorites');
    expect(navigationTabForPath('/cart')).toBe('cart');
    expect(navigationTabForPath('/profile')).toBe('account');
  });

  it('keeps product and nested account destinations highlighted', () => {
    expect(navigationTabForPath('/product/12')).toBe('shop');
    expect(navigationTabForPath('/profile/addresses/4/edit')).toBe('account');
    expect(navigationTabForPath('/profile/settings')).toBe('account');
    expect(navigationTabForPath('/orders/abc?from=history')).toBe('account');
    expect(navigationTabForPath('/help/faq')).toBe('account');
  });
});
