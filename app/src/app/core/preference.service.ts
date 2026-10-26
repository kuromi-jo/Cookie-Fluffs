/**
 * @file preference.service.ts
 * @description Persists and applies customer accessibility preferences.
 */
import { HttpClient } from '@angular/common/http';
import { Injectable, computed, effect, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { environment } from '../../environments/environment';
import { AuthService } from './auth.service';
import { UserPreferences } from './models';

const DEFAULTS: UserPreferences = { reduceMotion: false, largerText: false, notifyOrderUpdates: true, updatedAt: null };

export function prefersReducedMotion(): boolean {
  const accountSetting = typeof document !== 'undefined'
    && document.documentElement.classList.contains('cf-reduce-motion');
  const systemSetting = typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  return accountSetting || systemSetting;
}

@Injectable({ providedIn: 'root' })
export class PreferenceService {
  private http = inject(HttpClient);
  private auth = inject(AuthService);
  private base = `${environment.apiUrl}/preferences`;
  private accountId: number | null = null;
  private generation = 0;
  private media = typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-reduced-motion: reduce)')
    : null;

  readonly preferences = signal<UserPreferences>(DEFAULTS);
  readonly loading = signal(false);
  readonly saving = signal(false);
  readonly error = signal('');
  readonly systemReduceMotion = signal(this.media?.matches ?? false);
  readonly effectiveReduceMotion = computed(
    () => this.systemReduceMotion() || this.preferences().reduceMotion,
  );

  constructor() {
    this.media?.addEventListener?.('change', (event) => this.systemReduceMotion.set(event.matches));
    effect(() => {
      const userId = this.auth.user()?.id ?? null;
      if (userId === this.accountId) return;
      this.accountId = userId;
      this.generation += 1;
      this.preferences.set(DEFAULTS);
      this.error.set('');
      if (userId !== null) void this.load().catch(() => undefined);
    });
    effect(() => {
      if (typeof document === 'undefined') return;
      document.documentElement.classList.toggle('cf-reduce-motion', this.effectiveReduceMotion());
      document.documentElement.classList.toggle('cf-larger-text', this.preferences().largerText);
    });
  }

  async load(): Promise<UserPreferences> {
    if (!this.auth.isLoggedIn()) return DEFAULTS;
    const generation = ++this.generation;
    this.loading.set(true);
    this.error.set('');
    try {
      const preferences = await firstValueFrom(this.http.get<UserPreferences>(this.base));
      if (generation === this.generation) this.preferences.set(preferences);
      return preferences;
    } catch {
      if (generation === this.generation) this.error.set('Your settings could not be loaded. Try again.');
      throw new Error('Preferences could not be loaded.');
    } finally {
      if (generation === this.generation) this.loading.set(false);
    }
  }

  async save(values: Pick<UserPreferences, 'reduceMotion' | 'largerText'> & { notifyOrderUpdates?: boolean }): Promise<UserPreferences> {
    this.saving.set(true);
    this.error.set('');
    try {
      const preferences = await firstValueFrom(this.http.put<UserPreferences>(this.base, values));
      this.preferences.set(preferences);
      return preferences;
    } catch {
      this.error.set('Your settings could not be saved. Try again.');
      throw new Error('Preferences could not be saved.');
    } finally {
      this.saving.set(false);
    }
  }
}
