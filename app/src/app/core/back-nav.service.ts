/**
 * @file back-nav.service.ts
 * @description Remembers the page the user came from, so account pages opened from elsewhere
 * (for example My Vouchers from checkout, or any side-menu link) take the back arrow to that page
 * instead of always dropping the user on Profile.
 */
import { Injectable, inject } from '@angular/core';
import { NavigationEnd, Router } from '@angular/router';
import { filter } from 'rxjs';

@Injectable({ providedIn: 'root' })
export class BackNavService {
  private router = inject(Router);
  /** The last fully loaded page. While a new page is being created this is still the page being left. */
  private current = '';

  constructor() {
    // `events` is optional so pages still construct with a simple Router stub in unit tests.
    this.router.events?.pipe(filter((e): e is NavigationEnd => e instanceof NavigationEnd)).subscribe((e) => {
      this.current = e.urlAfterRedirects;
    });
  }

  /**
   * Call from a page's field initializer (while it is being created): the page the user came from,
   * or `fallback` on a fresh load, a reload, or when coming from login.
   */
  backHref(fallback: string, ownPath: string): string {
    const from = this.current.split('#')[0];
    const path = from.split('?')[0];
    if (!from || path === ownPath || path.startsWith('/login')) return fallback;
    return from;
  }
}
