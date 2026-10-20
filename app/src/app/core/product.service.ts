/**
 * @file product.service.ts
 * @description Loads the cookie catalog from the API (Neon) and keeps it in memory.
 */
import { Injectable, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { environment } from '../../environments/environment';
import { apiErrorMessage } from './api-error';
import { Product } from './models';

@Injectable({ providedIn: 'root' })
export class ProductService {
  private http = inject(HttpClient);
  private base = `${environment.apiUrl}/products`;

  readonly products = signal<Product[]>([]);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  readonly loaded = signal(false);

  private inFlight: Promise<void> | null = null;

  /** Fetches the full menu. Safe to call many times; concurrent calls share one request. */
  load(force = false): Promise<void> {
    if (this.inFlight) return this.inFlight;
    if (this.loaded() && !force) return Promise.resolve();

    this.loading.set(true);
    this.error.set(null);
    this.inFlight = firstValueFrom(this.http.get<Product[]>(this.base))
      .then((list) => {
        this.products.set(list);
        this.loaded.set(true);
      })
      .catch((err) => this.error.set(apiErrorMessage(err)))
      .finally(() => {
        this.loading.set(false);
        this.inFlight = null;
      });
    return this.inFlight;
  }

  /** Returns a product from memory, or asks the API if it has not been loaded yet. */
  async getById(id: number): Promise<Product> {
    const cached = this.products().find((p) => p.id === id);
    if (cached) return cached;
    return firstValueFrom(this.http.get<Product>(`${this.base}/${id}`));
  }
}
