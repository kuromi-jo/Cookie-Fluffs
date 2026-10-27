/**
 * @file product.service.ts
 * @description Loads the public catalog online, with versioned cache and bundled read-only fallbacks.
 */
import { DestroyRef, Injectable, computed, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { environment } from '../../environments/environment';
import { apiErrorMessage } from './api-error';
import { CookieCategory, Product } from './models';
import { BUNDLED_CATALOG, CATALOG_SNAPSHOT_VERSION } from './catalog-snapshot';

export type CatalogSource = 'fresh' | 'cached' | 'bundled';

export const CATALOG_CACHE_KEY = 'cf.public-catalog.v1';
export const CATALOG_CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_CACHE_BYTES = 250_000;
const CATEGORIES = new Set<CookieCategory>(['classic', 'nutty', 'fruity', 'indulgent', 'dietary']);

interface CatalogCacheEnvelope {
  version: number;
  savedAt: number;
  products: Product[];
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/** Rejects malformed API/cache data before it can become the visible catalog. */
export function isPublicProduct(value: unknown): value is Product {
  if (!value || typeof value !== 'object') return false;
  const p = value as Partial<Product>;
  return Number.isInteger(p.id) && Number(p.id) > 0
    && isString(p.slug) && Boolean(p.slug)
    && isString(p.name) && Boolean(p.name)
    && isString(p.tagline) && isString(p.description) && isString(p.flavorNotes)
    && isString(p.category) && CATEGORIES.has(p.category as CookieCategory)
    && isNumber(p.price) && isNumber(p.rating) && isNumber(p.reviewsCount) && isNumber(p.calories)
    && Array.isArray(p.allergens) && p.allergens.every(isString)
    && (p.badge === null || isString(p.badge))
    && isString(p.imageUrl) && p.imageUrl.startsWith('assets/cookies/')
    && typeof p.isAvailable === 'boolean' && typeof p.isBestSeller === 'boolean' && typeof p.isNew === 'boolean'
    && (p.salePrice === null || isNumber(p.salePrice))
    && (p.season === undefined || p.season === null || isString(p.season));
}

export function isPublicCatalog(value: unknown): value is Product[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 100 || !value.every(isPublicProduct)) return false;
  return new Set(value.map((product) => product.id)).size === value.length
    && new Set(value.map((product) => product.slug)).size === value.length;
}

function copyCatalog(products: readonly Product[]): Product[] {
  return products.map((product) => ({ ...product, allergens: [...product.allergens] }));
}

function browserStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export function readCatalogCache(storage: Storage | null, now = Date.now()): Product[] | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(CATALOG_CACHE_KEY);
    if (!raw || raw.length > MAX_CACHE_BYTES) return null;
    const parsed = JSON.parse(raw) as Partial<CatalogCacheEnvelope>;
    if (parsed.version !== CATALOG_SNAPSHOT_VERSION
      || !isNumber(parsed.savedAt)
      || now - parsed.savedAt > CATALOG_CACHE_MAX_AGE_MS
      || !isPublicCatalog(parsed.products)) return null;
    return copyCatalog(parsed.products);
  } catch {
    return null;
  }
}

function writeCatalogCache(storage: Storage | null, products: Product[]): void {
  if (!storage) return;
  try {
    storage.setItem(CATALOG_CACHE_KEY, JSON.stringify({
      version: CATALOG_SNAPSHOT_VERSION,
      savedAt: Date.now(),
      products,
    } satisfies CatalogCacheEnvelope));
  } catch {
    // Browsing still works from memory when storage is unavailable or full.
  }
}

@Injectable({ providedIn: 'root' })
export class ProductService {
  private http = inject(HttpClient);
  private destroyRef = inject(DestroyRef);
  private base = `${environment.apiUrl}/products`;
  private storage = browserStorage();
  private cached = readCatalogCache(this.storage);

  readonly products = signal<Product[]>(this.cached ?? copyCatalog(BUNDLED_CATALOG));
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  readonly loaded = signal(true);
  readonly source = signal<CatalogSource>(this.cached ? 'cached' : 'bundled');
  readonly online = signal(typeof navigator === 'undefined' ? true : navigator.onLine);
  readonly usingFallback = computed(() => !this.online() || this.source() !== 'fresh');

  private inFlight: Promise<void> | null = null;

  constructor() {
    if (typeof window === 'undefined') return;
    const offline = () => {
      this.online.set(false);
      if (this.source() === 'fresh') this.source.set('cached');
    };
    const online = () => {
      const reconnected = !this.online();
      this.online.set(true);
      if (reconnected || this.source() !== 'fresh') void this.load(true);
    };
    window.addEventListener('offline', offline);
    window.addEventListener('online', online);
    this.destroyRef.onDestroy(() => {
      window.removeEventListener('offline', offline);
      window.removeEventListener('online', online);
    });
  }

  /** Fetches the full menu. Cached/bundled products remain visible if the request fails. */
  load(force = false): Promise<void> {
    if (this.inFlight) return this.inFlight;
    if (this.source() === 'fresh' && !force) return Promise.resolve();

    this.loading.set(true);
    this.error.set(null);
    this.inFlight = firstValueFrom(this.http.get<unknown>(this.base))
      .then((value) => {
        if (!isPublicCatalog(value)) throw new Error('The menu response is invalid.');
        const products = copyCatalog(value);
        this.products.set(products);
        this.source.set('fresh');
        writeCatalogCache(this.storage, products);
      })
      .catch((err) => {
        if (this.source() === 'fresh') this.source.set('cached');
        if (!this.products().length) this.error.set(apiErrorMessage(err));
      })
      .finally(() => {
        this.loading.set(false);
        this.inFlight = null;
      });
    return this.inFlight;
  }

  /** Returns a browsing product immediately from memory, including safe offline fallbacks. */
  async getById(id: number): Promise<Product> {
    const available = this.products().find((product) => product.id === id);
    if (available) return available;
    return this.getLiveById(id);
  }

  /** Retrieves current server data before an action that can affect the cart. */
  async getLiveById(id: number): Promise<Product> {
    const product = await firstValueFrom(this.http.get<unknown>(`${this.base}/${id}`));
    if (!isPublicProduct(product)) throw new Error('The cookie response is invalid.');
    return { ...product, allergens: [...product.allergens] };
  }

  /** Confirms that the full catalog is live before entering a price-dependent builder flow. */
  async refreshForCommerce(): Promise<boolean> {
    await this.load(true);
    return this.source() === 'fresh';
  }
}
