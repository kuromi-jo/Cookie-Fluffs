/**
 * @file product-detail.page.spec.ts
 * @description Shared-catalog refresh and stable customer-selection tests for Product Details.
 */
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BUNDLED_CATALOG } from '../../core/catalog-snapshot';
import { CartService } from '../../core/cart.service';
import { FavoriteService } from '../../core/favorite.service';
import { Product } from '../../core/models';
import { ProductService } from '../../core/product.service';
import { ShopActionsService } from '../../core/shop-actions.service';
import { ProductDetailPage } from './product-detail.page';

describe('ProductDetailPage resilient catalog', () => {
  const catalog = signal<Product[]>([{ ...BUNDLED_CATALOG[0], allergens: [...BUNDLED_CATALOG[0].allergens] }]);
  const source = signal<'fresh' | 'cached' | 'bundled'>('bundled');
  const products = {
    products: catalog,
    source,
    usingFallback: () => source() !== 'fresh',
    load: vi.fn(async () => undefined),
    getLiveById: vi.fn(async () => BUNDLED_CATALOG[0]),
  };

  beforeEach(() => {
    catalog.set([{ ...BUNDLED_CATALOG[0], allergens: [...BUNDLED_CATALOG[0].allergens] }]);
    source.set('bundled');
    vi.clearAllMocks();
    TestBed.configureTestingModule({
      imports: [ProductDetailPage],
      providers: [
        provideRouter([]),
        { provide: ProductService, useValue: products },
        { provide: CartService, useValue: { quantityOf: () => 0, count: signal(0) } },
        { provide: FavoriteService, useValue: { isBusy: () => false, isFavorite: () => false, toggle: vi.fn() } },
        { provide: ShopActionsService, useValue: { addSingle: vi.fn(), startBox: vi.fn() } },
      ],
    });
  });

  it('updates from the shared catalog after reconnect without resetting quantity or pack', () => {
    const fixture = TestBed.createComponent(ProductDetailPage);
    fixture.componentRef.setInput('id', String(BUNDLED_CATALOG[0].id));
    fixture.detectChanges();
    const page = fixture.componentInstance;
    page.qty.set(3);
    page.pack.set(6);

    catalog.set([{ ...BUNDLED_CATALOG[0], name: 'Fresh Choco Chip', price: 125 }]);
    source.set('fresh');
    fixture.detectChanges();

    expect(page.product()).toMatchObject({ id: BUNDLED_CATALOG[0].id, name: 'Fresh Choco Chip', price: 125 });
    expect(page.qty()).toBe(3);
    expect(page.pack()).toBe(6);
    expect(products.getLiveById).not.toHaveBeenCalled();
  });

  it('handles a product removed by the refreshed catalog without retaining stale details', () => {
    const fixture = TestBed.createComponent(ProductDetailPage);
    fixture.componentRef.setInput('id', String(BUNDLED_CATALOG[0].id));
    fixture.detectChanges();
    const page = fixture.componentInstance;

    catalog.set([]);
    source.set('fresh');
    fixture.detectChanges();

    expect(page.product()).toBeNull();
    expect(page.displayError()).toBe('This cookie is no longer on the menu.');
  });
});
