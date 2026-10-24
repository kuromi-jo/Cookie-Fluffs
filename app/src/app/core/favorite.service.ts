/**
 * @file favorite.service.ts
 * @description Authenticated favorites state with optimistic rollback-safe updates.
 */
import { HttpClient } from '@angular/common/http';
import { Injectable, computed, effect, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { environment } from '../../environments/environment';
import { apiErrorMessage } from './api-error';
import { AuthService } from './auth.service';
import { FavoriteProduct, Product } from './models';
import { UiService } from './ui.service';

@Injectable({ providedIn: 'root' })
export class FavoriteService {
  private http = inject(HttpClient);
  private auth = inject(AuthService);
  private router = inject(Router);
  private ui = inject(UiService);
  private base = `${environment.apiUrl}/favorites`;
  private loadGeneration = 0;
  private accountId: number | null = null;

  readonly favorites = signal<FavoriteProduct[]>([]);
  readonly loading = signal(false);
  readonly loaded = signal(false);
  readonly error = signal('');
  readonly busy = signal<ReadonlySet<number>>(new Set());
  readonly ids = computed(() => new Set(this.favorites().map((product) => product.id)));

  constructor() {
    effect(() => {
      const userId = this.auth.user()?.id ?? null;
      if (userId === this.accountId) return;
      this.accountId = userId;
      this.loadGeneration += 1;
      this.favorites.set([]);
      this.loaded.set(false);
      this.error.set('');
      this.busy.set(new Set());
      if (userId !== null) void this.load(true).catch(() => undefined);
    });
  }

  isFavorite(productId: number): boolean {
    return this.ids().has(productId);
  }

  isBusy(productId: number): boolean {
    return this.busy().has(productId);
  }

  async load(force = false): Promise<FavoriteProduct[]> {
    if (!this.auth.isLoggedIn()) return [];
    if (this.loaded() && !force) return this.favorites();
    const generation = ++this.loadGeneration;
    this.loading.set(true);
    this.error.set('');
    try {
      const response = await firstValueFrom(this.http.get<{ favorites: FavoriteProduct[] }>(this.base));
      if (generation === this.loadGeneration) {
        this.favorites.set(response.favorites);
        this.loaded.set(true);
      }
      return response.favorites;
    } catch (error) {
      if (generation === this.loadGeneration) this.error.set(apiErrorMessage(error));
      throw error;
    } finally {
      if (generation === this.loadGeneration) this.loading.set(false);
    }
  }

  async toggle(product: Product, returnUrl = this.router.url): Promise<void> {
    if (!this.auth.isLoggedIn()) {
      await this.router.navigate(['/login'], { queryParams: { returnUrl } });
      return;
    }
    if (this.isBusy(product.id)) return;
    const previous = this.favorites();
    const removing = this.isFavorite(product.id);
    const optimistic = removing
      ? previous.filter((entry) => entry.id !== product.id)
      : [{ ...product, favoritedAt: new Date().toISOString() }, ...previous];
    this.favorites.set(optimistic);
    this.setBusy(product.id, true);
    this.error.set('');
    try {
      if (removing) {
        await firstValueFrom(this.http.delete<void>(`${this.base}/${product.id}`));
        await this.ui.toast('Removed from favorites.', { icon: 'heart-outline' });
      } else {
        await firstValueFrom(this.http.put(`${this.base}/${product.id}`, {}));
        await this.ui.toast('Saved to favorites.', { icon: 'heart' });
      }
      this.loaded.set(true);
    } catch (error) {
      this.favorites.set(previous);
      const message = apiErrorMessage(error);
      this.error.set(message);
      await this.ui.toast(message, { error: true });
    } finally {
      this.setBusy(product.id, false);
    }
  }

  private setBusy(productId: number, active: boolean): void {
    this.busy.update((current) => {
      const next = new Set(current);
      if (active) next.add(productId);
      else next.delete(productId);
      return next;
    });
  }
}
