/**
 * @file product.service.spec.ts
 * @description Verifies online catalog preference, safe offline fallbacks, cache validation, and reconnection.
 */
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BUNDLED_CATALOG, CATALOG_SNAPSHOT_VERSION } from './catalog-snapshot';
import {
  CATALOG_CACHE_KEY,
  CATALOG_CACHE_MAX_AGE_MS,
  ProductService,
  readCatalogCache,
} from './product.service';

class MemoryStorage implements Storage {
  private data = new Map<string, string>();
  get length(): number { return this.data.size; }
  clear(): void { this.data.clear(); }
  getItem(key: string): string | null { return this.data.get(key) ?? null; }
  key(index: number): string | null { return [...this.data.keys()][index] ?? null; }
  removeItem(key: string): void { this.data.delete(key); }
  setItem(key: string, value: string): void { this.data.set(key, value); }
}

describe('ProductService resilient catalog', () => {
  let storage: MemoryStorage;
  let service: ProductService;
  let http: HttpTestingController;

  beforeEach(() => {
    storage = new MemoryStorage();
    vi.stubGlobal('localStorage', storage);
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
  });

  afterEach(() => {
    http?.verify();
    TestBed.resetTestingModule();
    vi.unstubAllGlobals();
  });

  function injectService(): void {
    service = TestBed.inject(ProductService);
    http = TestBed.inject(HttpTestingController);
  }

  it('shows the bundled public catalog on a fresh installation, then prefers the API', async () => {
    injectService();
    expect(service.source()).toBe('bundled');
    expect(service.products()).toHaveLength(BUNDLED_CATALOG.length);
    expect(service.products().every((product) => product.imageUrl.startsWith('assets/cookies/'))).toBe(true);

    const loading = service.load();
    http.expectOne('/api/products').flush(BUNDLED_CATALOG.map((product) => ({ ...product, price: product.price + 1 })));
    await loading;

    expect(service.source()).toBe('fresh');
    expect(service.products()[0].price).toBe(BUNDLED_CATALOG[0].price + 1);
    expect(storage.getItem(CATALOG_CACHE_KEY)).not.toContain('token');
  });

  it('keeps bundled products browsable when the API is unavailable', async () => {
    injectService();
    const loading = service.load();
    http.expectOne('/api/products').flush({ message: 'Unavailable' }, { status: 503, statusText: 'Unavailable' });
    await loading;
    expect(service.source()).toBe('bundled');
    expect(service.usingFallback()).toBe(true);
    expect(service.error()).toBeNull();
    await expect(service.getById(168)).resolves.toMatchObject({ slug: 'oreo-vanilla' });
  });

  it('restores a valid last-known-good cache after relaunch', () => {
    storage.setItem(CATALOG_CACHE_KEY, JSON.stringify({
      version: CATALOG_SNAPSHOT_VERSION,
      savedAt: Date.now(),
      products: BUNDLED_CATALOG.map((product) => ({ ...product, price: product.price + 2 })),
    }));
    injectService();
    expect(service.source()).toBe('cached');
    expect(service.products()[0].price).toBe(BUNDLED_CATALOG[0].price + 2);
  });

  it('rejects corrupt, incompatible, and expired caches', () => {
    storage.setItem(CATALOG_CACHE_KEY, '{broken');
    expect(readCatalogCache(storage)).toBeNull();
    storage.setItem(CATALOG_CACHE_KEY, JSON.stringify({ version: 99, savedAt: Date.now(), products: BUNDLED_CATALOG }));
    expect(readCatalogCache(storage)).toBeNull();
    storage.setItem(CATALOG_CACHE_KEY, JSON.stringify({
      version: CATALOG_SNAPSHOT_VERSION,
      savedAt: Date.now() - CATALOG_CACHE_MAX_AGE_MS - 1,
      products: BUNDLED_CATALOG,
    }));
    expect(readCatalogCache(storage)).toBeNull();
  });

  it('refreshes automatically after the browser reports that connectivity returned', async () => {
    injectService();
    window.dispatchEvent(new Event('online'));
    http.expectOne('/api/products').flush(BUNDLED_CATALOG);
    await vi.waitFor(() => expect(service.source()).toBe('fresh'));
  });

  it('shows fallback state immediately when the device loses connectivity', async () => {
    injectService();
    const loading = service.load();
    http.expectOne('/api/products').flush(BUNDLED_CATALOG);
    await loading;
    expect(service.usingFallback()).toBe(false);

    window.dispatchEvent(new Event('offline'));
    expect(service.online()).toBe(false);
    expect(service.source()).toBe('cached');
    expect(service.usingFallback()).toBe(true);
    expect(service.products()).toHaveLength(BUNDLED_CATALOG.length);
  });

  it('coalesces reconnect events into one refresh and clears fallback state after success', async () => {
    injectService();
    window.dispatchEvent(new Event('offline'));
    window.dispatchEvent(new Event('online'));
    window.dispatchEvent(new Event('online'));

    const request = http.expectOne('/api/products');
    request.flush(BUNDLED_CATALOG.map((product) => ({ ...product, name: `${product.name} refreshed` })));
    await vi.waitFor(() => expect(service.usingFallback()).toBe(false));
    http.expectNone('/api/products');
    expect(service.products()[0].name).toContain('refreshed');
  });

  it('requires a live product response for commerce validation', async () => {
    injectService();
    const { id } = BUNDLED_CATALOG[0];
    const request = service.getLiveById(id);
    http.expectOne(`/api/products/${id}`).flush(BUNDLED_CATALOG[0]);
    await expect(request).resolves.toMatchObject({ id, slug: 'choco-chip' });
  });

  it('does not authorize price-dependent flows when a forced refresh fails', async () => {
    injectService();
    const check = service.refreshForCommerce();
    http.expectOne('/api/products').flush({ message: 'Offline' }, { status: 503, statusText: 'Unavailable' });
    await expect(check).resolves.toBe(false);
  });
});
