/**
 * @file notifications.page.spec.ts
 * @description Notification center guard, load, open/mark-read, mark-all, and relative-time tests.
 */
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthService } from '../../core/auth.service';
import { NotificationService } from '../../core/notification.service';
import { AppNotification } from '../../core/models';
import { NotificationsPage, isSafeNotificationLink } from './notifications.page';

function note(id: string, linkPath: string | null = '/orders/x', read = false): AppNotification {
  return {
    id, category: 'order', eventType: 'order_placed', title: 'Order placed',
    body: 'Thanks!', linkPath, read, createdAt: new Date().toISOString(),
  };
}

describe('NotificationsPage', () => {
  const items = signal<AppNotification[]>([]);
  const notifications = {
    items,
    nextCursor: signal<string | null>(null),
    loading: signal(false),
    loadingMore: signal(false),
    error: signal(''),
    unread: signal(0),
    unreadStale: signal(false),
    hasUnread: signal(false),
    load: vi.fn(async () => undefined),
    loadMore: vi.fn(async () => undefined),
    markRead: vi.fn(async () => undefined),
    markAllRead: vi.fn(async () => undefined),
    refreshUnread: vi.fn(async () => undefined),
  };
  const auth = { isLoggedIn: vi.fn(() => true) };
  const router = { navigate: vi.fn(async () => true), navigateByUrl: vi.fn(async () => true) };

  beforeEach(() => {
    vi.clearAllMocks();
    auth.isLoggedIn.mockReturnValue(true);
    items.set([]);
    TestBed.configureTestingModule({ providers: [
      { provide: NotificationService, useValue: notifications },
      { provide: AuthService, useValue: auth },
      { provide: Router, useValue: router },
    ] });
  });

  const page = () => TestBed.runInInjectionContext(() => new NotificationsPage());

  it('redirects guests to login with the notifications return url', async () => {
    auth.isLoggedIn.mockReturnValue(false);
    await page().ionViewWillEnter();
    expect(router.navigate).toHaveBeenCalledWith(['/login'], {
      queryParams: { returnUrl: '/notifications' }, replaceUrl: true,
    });
    expect(notifications.load).not.toHaveBeenCalled();
  });

  it('loads notifications on entry for an authenticated customer', async () => {
    await page().ionViewWillEnter();
    expect(notifications.load).toHaveBeenCalledOnce();
  });

  it('marks a notification read and navigates to its linked page', async () => {
    const component = page();
    await component.open(note('a', '/orders/abc'));
    expect(notifications.markRead).toHaveBeenCalledWith('a');
    expect(router.navigateByUrl).toHaveBeenCalledWith('/orders/abc');
  });

  it('marks read without navigating when the notification has no link', async () => {
    const component = page();
    await component.open(note('a', null));
    expect(notifications.markRead).toHaveBeenCalledWith('a');
    expect(router.navigateByUrl).not.toHaveBeenCalled();
  });

  it('marks read but does NOT navigate for unsafe links (D2)', async () => {
    const component = page();
    const unsafe = [
      'https://evil.example/phish',   // external URL (scheme)
      '//evil.example/phish',         // protocol-relative
      '/orders/%2e%2e/admin',         // encoded bypass
      'javascript:alert(1)',          // scheme, not root-relative
      'orders/abc',                   // not root-relative
      '/orders?next=https://evil',    // query/colon not allowed
    ];
    for (const linkPath of unsafe) {
      await component.open(note('a', linkPath));
      expect(notifications.markRead).toHaveBeenCalledWith('a'); // read still applied
    }
    expect(router.navigateByUrl).not.toHaveBeenCalled(); // never navigated for any unsafe link
  });

  it('isSafeNotificationLink accepts internal root-relative paths and rejects unsafe ones (D2)', () => {
    expect(isSafeNotificationLink('/orders/abc')).toBe(true);
    expect(isSafeNotificationLink('/profile/security')).toBe(true);
    expect(isSafeNotificationLink('/')).toBe(true);
    expect(isSafeNotificationLink(null)).toBe(false);
    expect(isSafeNotificationLink('')).toBe(false);
    expect(isSafeNotificationLink('https://evil.example')).toBe(false);
    expect(isSafeNotificationLink('//evil.example')).toBe(false);
    expect(isSafeNotificationLink('/a%2Fb')).toBe(false); // encoded
    expect(isSafeNotificationLink('/a?b=c')).toBe(false);
    expect(isSafeNotificationLink('relative/path')).toBe(false);
  });

  it('delegates mark-all-read to the service', async () => {
    await page().markAllRead();
    expect(notifications.markAllRead).toHaveBeenCalledOnce();
  });

  it('formats recent timestamps as short relative time', () => {
    const component = page();
    expect(component.relativeTime(new Date().toISOString())).toBe('just now');
    expect(component.relativeTime(new Date(Date.now() - 5 * 60_000).toISOString())).toBe('5m');
    expect(component.relativeTime(new Date(Date.now() - 3 * 3_600_000).toISOString())).toBe('3h');
  });

  it('maps categories to icons', () => {
    const component = page();
    expect(component.categoryIcon('order')).toBe('receipt-outline');
    expect(component.categoryIcon('payment')).toBe('card-outline');
    expect(component.categoryIcon('security')).toBe('lock-closed-outline');
  });
});
