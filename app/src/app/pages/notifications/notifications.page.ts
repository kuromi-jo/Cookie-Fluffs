/**
 * @file notifications.page.ts
 * @description Mobile notification center: lists owner notifications, marks read, and refreshes
 * on entry, app resume, and reconnection without constant polling.
 */
import { Component, DestroyRef, inject, input, signal } from '@angular/core';
import { Router } from '@angular/router';
import {
  IonBackButton,
  IonButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonIcon,
  IonInfiniteScroll,
  IonInfiniteScrollContent,
  IonSkeletonText,
  IonTitle,
  IonToolbar,
  ModalController,
  NavController,
} from '@ionic/angular';
import { AuthService } from '../../core/auth.service';
import { NotificationService } from '../../core/notification.service';
import { AppNotification, NotificationCategory } from '../../core/models';

const CATEGORY_ICON: Record<NotificationCategory, string> = {
  order: 'receipt-outline',
  payment: 'card-outline',
  security: 'lock-closed-outline',
};

// Mirrors the server's notification link validator (notification-service.js INTERNAL_PATH_RE):
// a safe link is a root-relative internal path of letters/digits/slash/underscore/hyphen only.
// This rejects external URLs (contain ':'), protocol-relative '//host' (contain '.'), and encoded
// bypasses like %2F (contain '%'), since none of those characters are in the allowed class.
const SAFE_INTERNAL_PATH_RE = /^\/[A-Za-z0-9/_-]*$/;

/** True only for a safe internal root-relative navigation path. */
export function isSafeNotificationLink(linkPath: string | null | undefined): linkPath is string {
  return typeof linkPath === 'string' && SAFE_INTERNAL_PATH_RE.test(linkPath);
}

@Component({
  selector: 'app-notifications',
  templateUrl: 'notifications.page.html',
  styleUrls: ['notifications.page.scss'],
  imports: [
    IonHeader,
    IonToolbar,
    IonButtons,
    IonBackButton,
    IonTitle,
    IonContent,
    IonButton,
    IonIcon,
    IonSkeletonText,
    IonInfiniteScroll,
    IonInfiniteScrollContent,
  ],
})
export class NotificationsPage {
  readonly notifications = inject(NotificationService);
  private auth = inject(AuthService);
  private router = inject(Router);
  private destroyRef = inject(DestroyRef);
  private modals = inject(ModalController);
  private nav = inject(NavController);
  /** True when opened as the slide-up sheet (bell); the X closes it and the page underneath is untouched. */
  readonly asSheet = input(false);
  readonly skeletons = [1, 2, 3, 4];
  private listenersBound = false;

  constructor() {
    const refresh = () => {
      if (document.visibilityState === 'visible') void this.notifications.load();
    };
    const reconnect = () => void this.notifications.load();
    if (typeof window !== 'undefined' && !this.listenersBound) {
      this.listenersBound = true;
      window.addEventListener('online', reconnect);
      document.addEventListener('visibilitychange', refresh);
      this.destroyRef.onDestroy(() => {
        window.removeEventListener('online', reconnect);
        document.removeEventListener('visibilitychange', refresh);
      });
    }
  }

  /** Where the back arrow goes. Entry points pass `state: { backTo }` (e.g. the Home bell); default is Profile. */
  readonly backHref = signal('/profile');

  async ionViewWillEnter(): Promise<void> {
    const backTo = (history.state as { backTo?: unknown } | null)?.backTo;
    this.backHref.set(typeof backTo === 'string' && backTo.startsWith('/') && !backTo.startsWith('//') ? backTo : '/profile');
    if (!this.auth.isLoggedIn()) {
      await this.router.navigate(['/login'], {
        queryParams: { returnUrl: '/notifications' },
        replaceUrl: true,
      });
      return;
    }
    await this.notifications.load();
  }

  categoryIcon(category: NotificationCategory): string {
    return CATEGORY_ICON[category] ?? 'notifications-outline';
  }

  retry(): void {
    void this.notifications.load();
  }

  async open(item: AppNotification): Promise<void> {
    // Always mark read; only navigate when the stored link is a safe internal path. The server
    // already validates links at write time; this is a defense-in-depth client guard so an
    // unexpected value can never drive navigation to an external/encoded/unsupported target.
    await this.notifications.markRead(item.id);
    if (!isSafeNotificationLink(item.linkPath)) return;
    if (this.asSheet()) await this.close();
    await this.router.navigateByUrl(item.linkPath);
  }

  async close(): Promise<void> {
    await this.modals.dismiss();
  }

  async browse(): Promise<void> {
    if (this.asSheet()) await this.close();
    await this.nav.navigateRoot('/shop');
  }

  async markAllRead(): Promise<void> {
    await this.notifications.markAllRead();
  }

  async loadMore(event: Event): Promise<void> {
    await this.notifications.loadMore();
    (event.target as HTMLIonInfiniteScrollElement).complete();
  }

  relativeTime(iso: string): string {
    return relativeTime(iso);
  }
}

/** Short relative time like "just now", "5m", "3h", "2d", else a date. Shared with the admin notifications. */
export function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const seconds = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (seconds < 45) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  return new Date(iso).toLocaleDateString('en-PH', { month: 'short', day: 'numeric' });
}
