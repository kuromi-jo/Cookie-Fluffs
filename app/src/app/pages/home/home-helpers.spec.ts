/**
 * @file home-helpers.spec.ts
 * @description Halloween countdown and All Cookies price-band rules.
 */
import { describe, expect, it } from 'vitest';
import { daysUntilHalloween } from './home.page';
import { inPriceBand } from '../shop/shop.page';
import { Product } from '../../core/models';

const cookie = (price: number, salePrice: number | null = null) => ({ price, salePrice }) as Product;

describe('daysUntilHalloween', () => {
  it('counts whole days down to Halloween and returns null after it', () => {
    expect(daysUntilHalloween(new Date(2026, 9, 27, 23, 30))).toBe(4);
    expect(daysUntilHalloween(new Date(2026, 9, 30, 8, 0))).toBe(1);
    expect(daysUntilHalloween(new Date(2026, 9, 31, 22, 0))).toBe(0);
    expect(daysUntilHalloween(new Date(2026, 10, 1, 0, 5))).toBeNull();
  });
});

describe('inPriceBand', () => {
  it('uses the price the customer pays, including promos', () => {
    expect(inPriceBand(cookie(135, 115), 'under-120')).toBe(true);
    expect(inPriceBand(cookie(135, 115), '120-140')).toBe(false);
  });

  it('includes both edges of the middle band', () => {
    expect(inPriceBand(cookie(120), '120-140')).toBe(true);
    expect(inPriceBand(cookie(140), '120-140')).toBe(true);
    expect(inPriceBand(cookie(145), 'over-140')).toBe(true);
    expect(inPriceBand(cookie(99), 'any')).toBe(true);
  });
});
