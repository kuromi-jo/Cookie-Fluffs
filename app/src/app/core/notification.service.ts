/**
 * @file notification.service.ts
 * @description Authenticated in-app notification state: list, unread count with offline
 * staleness, and read operations. State is cleared when the signed-in account changes so a
 * previous customer's notifications never leak into another session.
 */
import { HttpClient } from '@angular/common/http';
import { Injectable, computed, effect, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { environment } from '../../environments/environment';
import { apiErrorMessage } from './api-error';
import { AuthService } from './auth.service';
import { AppNotification } from './models';

interface NotificationPage {
  notifications: AppNotification[];
  nextCursor: string | null;
}

@Injectable({ providedIn: 'root' })
export class NotificationService {
  private http = inject(HttpClient);
  private auth = inject(AuthService);
  private base = `${environment.apiUrl}/notifications`;
  private accountId: number | null = null;
  private loadGeneration = 0;

  readonly items = signal<AppNotification[]>([]);
  readonly nextCursor = signal<string | null>(null);
  readonly loading = signal(false);
  readonly loadingMore = signal(false);
  readonly error = signal('');

  readonly unread = signal(0);
  // True when the unread count could not be refreshed (offline / failed fetch). The badge
  // dims rather than presenting a possibly-stale number as current.
  readonly unreadStale = signal(false);

  readonly hasUnread = computed(() => this.unread() > 0);

  constructor() {
    effect(() => {
      const userId = this.auth.user()?.id ?? null;
      if (userId === this.accountId) return;
      this.accountId = userId;
      this.loadGeneration += 1;
      this.reset();
      if (userId !== null) void this.refreshUnread().catch(() => undefined);
    });
  }

  private reset(): void {
    this.items.set([]);
    this.nextCursor.set(null);
    this.error.set('');
    this.unread.set(0);
    this.unreadStale.set(false);
  }

  /** Lightweight unread refresh for the badge (used on entry, resume, reconnection). */
  async refreshUnread(): Promise<void> {
    if (!this.auth.isLoggedIn()) return;
    try {
      const { count } = await firstValueFrom(
        this.http.get<{ count: number }>(`${this.base}/unread-count`),
      );
      this.unread.set(count);
      this.unreadStale.set(false);
    } catch {
      // Keep the last known number but mark it stale so the UI can indicate it may be outdated.
      this.unreadStale.set(true);
    }
  }

  /** Loads the first page of notifications and refreshes the unread count. */
  async load(): Promise<void> {
    if (!this.auth.isLoggedIn()) return;
    const generation = ++this.loadGeneration;
    this.loading.set(true);
    this.error.set('');
    try {
      const page = await firstValueFrom(this.http.get<NotificationPage>(this.base));
      if (generation !== this.loadGeneration) return;
      this.items.set(page.notifications);
      this.nextCursor.set(page.nextCursor);
      await this.refreshUnread();
    } catch (error) {
      if (generation === this.loadGeneration) this.error.set(apiErrorMessage(error));
    } finally {
      if (generation === this.loadGeneration) this.loading.set(false);
    }
  }

  /** Loads the next page when a cursor is available. */
  async loadMore(): Promise<void> {
    const cursor = this.nextCursor();
    if (!cursor || this.loadingMore()) return;
    this.loadingMore.set(true);
    try {
      const page = await firstValueFrom(
        this.http.get<NotificationPage>(`${this.base}?cursor=${encodeURIComponent(cursor)}`),
      );
      this.items.update((current) => [...current, ...page.notifications]);
      this.nextCursor.set(page.nextCursor);
    } catch (error) {
      this.error.set(apiErrorMessage(error));
    } finally {
      this.loadingMore.set(false);
    }
  }

  /** Marks one notification read and updates the badge immediately. */
  async markRead(id: string): Promise<void> {
    const target = this.items().find((item) => item.id === id);
    if (!target || target.read) return;
    // Snapshot the account this request belongs to, so a reset/account-switch that happens while
    // the request is in flight cannot be clobbered by a late rollback.
    const account = this.accountId;
    this.items.update((current) => current.map((item) => (item.id === id ? { ...item, read: true } : item)));
    this.unread.update((count) => Math.max(0, count - 1));
    try {
      await firstValueFrom(this.http.post(`${this.base}/${id}/read`, {}));
    } catch {
      // The optimistic update could not be persisted. Only roll back if we are still on the same
      // account (reset() already cleared state otherwise) and the item is still present and still
      // shows read (do not overwrite a newer successful state for the same id).
      if (this.accountId === account) {
        this.items.update((current) =>
          current.map((item) => (item.id === id && item.read ? { ...item, read: false } : item)));
        await this.refreshUnread();
      }
    }
  }

  /** Marks every notification read and zeroes the badge immediately. */
  async markAllRead(): Promise<void> {
    if (!this.hasUnread()) return;
    const previous = this.items();
    this.items.update((current) => current.map((item) => ({ ...item, read: true })));
    this.unread.set(0);
    try {
      await firstValueFrom(this.http.post(`${this.base}/read-all`, {}));
    } catch (error) {
      this.items.set(previous);
      this.error.set(apiErrorMessage(error));
      await this.refreshUnread();
    }
  }
}
