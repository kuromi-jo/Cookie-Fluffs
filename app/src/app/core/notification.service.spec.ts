/**
 * @file notification.service.spec.ts
 * @description Notification loading, unread badge, optimistic read updates, offline staleness,
 * and account-switch clearing tests.
 */
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthService } from './auth.service';
import { NotificationService } from './notification.service';
import { AppNotification, User } from './models';

const user = { id: 7 } as User;
const other = { id: 9 } as User;

function note(id: string, read = false): AppNotification {
  return {
    id, category: 'order', eventType: 'order_placed', title: 'Order placed',
    body: 'Thanks!', linkPath: '/orders/x', read, createdAt: '2026-10-26T00:00:00.000Z',
  };
}

describe('NotificationService', () => {
  const currentUser = signal<User | null>(null);
  const auth = { user: currentUser, isLoggedIn: () => currentUser() !== null };
  let service: NotificationService;
  let http: HttpTestingController;

  beforeEach(() => {
    currentUser.set(null);
    vi.clearAllMocks();
    TestBed.configureTestingModule({ providers: [
      provideHttpClient(), provideHttpClientTesting(),
      { provide: AuthService, useValue: auth },
    ] });
    service = TestBed.inject(NotificationService);
    http = TestBed.inject(HttpTestingController);
  });
  afterEach(() => http.verify());

  it('refreshes the unread badge when an account signs in', async () => {
    currentUser.set(user);
    TestBed.flushEffects();
    http.expectOne('/api/notifications/unread-count').flush({ count: 2 });
    await Promise.resolve();
    expect(service.unread()).toBe(2);
    expect(service.hasUnread()).toBe(true);
    expect(service.unreadStale()).toBe(false);
  });

  it('loads a page then marks one read and decrements the badge immediately', async () => {
    currentUser.set(user);
    TestBed.flushEffects();
    http.expectOne('/api/notifications/unread-count').flush({ count: 2 });
    await Promise.resolve();

    const load = service.load();
    http.expectOne('/api/notifications').flush({ notifications: [note('a'), note('b', true)], nextCursor: null });
    await Promise.resolve();
    http.expectOne('/api/notifications/unread-count').flush({ count: 1 });
    await load;
    expect(service.items()).toHaveLength(2);

    const mark = service.markRead('a');
    expect(service.unread()).toBe(0); // optimistic decrement
    expect(service.items().find((n) => n.id === 'a')?.read).toBe(true);
    http.expectOne('/api/notifications/a/read').flush(null);
    await mark;
  });

  it('marks all read and zeroes the badge', async () => {
    currentUser.set(user);
    TestBed.flushEffects();
    http.expectOne('/api/notifications/unread-count').flush({ count: 3 });
    await Promise.resolve();
    const load = service.load();
    http.expectOne('/api/notifications').flush({ notifications: [note('a'), note('b')], nextCursor: null });
    await Promise.resolve();
    http.expectOne('/api/notifications/unread-count').flush({ count: 2 });
    await load;

    const all = service.markAllRead();
    expect(service.unread()).toBe(0);
    expect(service.items().every((n) => n.read)).toBe(true);
    http.expectOne('/api/notifications/read-all').flush({ updated: 2 });
    await all;
  });

  it('marks the unread count stale when the refresh fails (offline)', async () => {
    currentUser.set(user);
    TestBed.flushEffects();
    http.expectOne('/api/notifications/unread-count').flush({ count: 5 });
    await Promise.resolve();

    const refresh = service.refreshUnread();
    http.expectOne('/api/notifications/unread-count').error(new ProgressEvent('offline'));
    await refresh;
    expect(service.unreadStale()).toBe(true);
    // Last known count is preserved (not reset to zero).
    expect(service.unread()).toBe(5);
  });

  it('rolls back the item read flag AND resyncs the badge when mark-read fails (D1)', async () => {
    currentUser.set(user);
    TestBed.flushEffects();
    http.expectOne('/api/notifications/unread-count').flush({ count: 2 });
    await Promise.resolve();
    const load = service.load();
    http.expectOne('/api/notifications').flush({ notifications: [note('a'), note('b', true)], nextCursor: null });
    await Promise.resolve();
    http.expectOne('/api/notifications/unread-count').flush({ count: 1 });
    await load;

    const mark = service.markRead('a');
    expect(service.items().find((n) => n.id === 'a')?.read).toBe(true); // optimistic
    expect(service.unread()).toBe(0);
    http.expectOne('/api/notifications/a/read').error(new ProgressEvent('offline'));
    await Promise.resolve(); // let the catch handler reach refreshUnread()
    // Rollback re-syncs the badge from the server.
    http.expectOne('/api/notifications/unread-count').flush({ count: 1 });
    await mark;
    expect(service.items().find((n) => n.id === 'a')?.read).toBe(false); // item read flag reverted
    expect(service.unread()).toBe(1); // badge consistent with server
  });

  it('does not roll back into a different account when mark-read fails after a switch (D1 isolation)', async () => {
    currentUser.set(user);
    TestBed.flushEffects();
    http.expectOne('/api/notifications/unread-count').flush({ count: 1 });
    await Promise.resolve();
    const load = service.load();
    http.expectOne('/api/notifications').flush({ notifications: [note('a')], nextCursor: null });
    await Promise.resolve();
    http.expectOne('/api/notifications/unread-count').flush({ count: 1 });
    await load;

    const mark = service.markRead('a'); // in flight for account 7
    const pending = http.expectOne('/api/notifications/a/read'); // captured, not yet resolved
    // Account switches while the request is pending; state resets and a new unread fetch fires.
    currentUser.set(other);
    TestBed.flushEffects();
    http.expectOne('/api/notifications/unread-count').flush({ count: 0 });
    await Promise.resolve();
    // Now the original request fails; the stale rollback must NOT touch the new account's state,
    // and must NOT issue a refreshUnread (guarded by the account snapshot).
    pending.error(new ProgressEvent('offline'));
    await mark;
    expect(service.items()).toHaveLength(0); // new account's empty list untouched
    expect(service.unread()).toBe(0);
  });

  it('clears all notification state when the account changes', async () => {
    currentUser.set(user);
    TestBed.flushEffects();
    http.expectOne('/api/notifications/unread-count').flush({ count: 4 });
    await Promise.resolve();
    expect(service.unread()).toBe(4);

    currentUser.set(other);
    TestBed.flushEffects();
    // State resets to empty immediately; a fresh unread fetch is issued for the new account.
    expect(service.unread()).toBe(0);
    expect(service.items()).toHaveLength(0);
    http.expectOne('/api/notifications/unread-count').flush({ count: 1 });
    await Promise.resolve();
    expect(service.unread()).toBe(1);
  });
});
