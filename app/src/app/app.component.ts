/**
 * @file app.component.ts
 * @description App shell: splash screen, side menu and the router outlet.
 */
import { NotificationSheetService } from './core/notification-sheet.service';
import { Component, computed, inject, signal } from '@angular/core';
import { NavigationEnd, Router, RouterLink } from '@angular/router';
import { HttpErrorResponse } from '@angular/common/http';
import { toSignal } from '@angular/core/rxjs-interop';
import { filter, map } from 'rxjs';
import {
  AlertController,
  IonApp,
  IonBadge,
  IonContent,
  IonFooter,
  IonIcon,
  IonItem,
  IonLabel,
  IonList,
  IonListHeader,
  IonMenu,
  IonMenuToggle,
  IonRouterLink,
  IonRouterOutlet,
  IonSpinner,
  MenuController,
} from '@ionic/angular';

import { registerAppIcons } from './icons';
import { SplashComponent } from './components/splash.component';
import { AvatarComponent } from './components/avatar.component';
import { AuthService } from './core/auth.service';
import { CartService } from './core/cart.service';
import { ProductService } from './core/product.service';
import { UiService } from './core/ui.service';
import { LiveService } from './core/live.service';
import { BackNavService } from './core/back-nav.service';
import { setAdminShopView } from './core/admin.service';
import { AdminMenuComponent } from './components/admin-menu.component';
import { SKIP_SPLASH_KEY } from './core/google-auth.service';
import { fileToAvatar } from './core/image';
import { apiErrorMessage } from './core/api-error';
import { PreferenceService } from './core/preference.service';

interface MenuLink {
  title: string;
  url: string;
  icon: string;
  note?: string;
}

export function menuLinkIsActive(currentUrl: string, linkUrl: string): boolean {
  const path = currentUrl.split('?')[0].split('#')[0];
  if (linkUrl === '/shop') return path === '/shop' || path.startsWith('/product/');
  if (linkUrl === '/orders') return path === '/orders' || path.startsWith('/orders/');
  if (linkUrl === '/profile/addresses') return path === linkUrl || path.startsWith(`${linkUrl}/`);
  if (linkUrl === '/help') return path === '/help' || path.startsWith('/help/');
  return path === linkUrl;
}

export async function closeMenuBeforeNavigation(
  event: Event,
  closeMenu: () => Promise<unknown>,
  navigate: () => Promise<unknown>,
  focusDestination: () => void,
): Promise<void> {
  const trigger = event.currentTarget instanceof HTMLElement ? event.currentTarget : null;
  trigger?.blur();
  const focused = document.activeElement;
  if (focused instanceof HTMLElement && focused.closest('ion-menu')) focused.blur();
  await closeMenu();
  await navigate();
  focusDestination();
}

const SPLASH_MIN_MS = 2400;

/** True (once) when the page was reloaded by the Google sign-in re-init rather than opened by the user. */
function consumeSkipSplash(): boolean {
  try {
    const skip = sessionStorage.getItem(SKIP_SPLASH_KEY) === '1';
    sessionStorage.removeItem(SKIP_SPLASH_KEY);
    return skip;
  } catch {
    return false;
  }
}

@Component({
  selector: 'app-root',
  templateUrl: 'app.component.html',
  styleUrls: ['app.component.scss'],
  imports: [
    RouterLink,
    IonApp,
    IonMenu,
    IonContent,
    IonList,
    IonListHeader,
    IonMenuToggle,
    IonItem,
    IonIcon,
    IonLabel,
    IonBadge,
    IonFooter,
    IonSpinner,
    IonRouterLink,
    IonRouterOutlet,
    SplashComponent,
    AvatarComponent,
    AdminMenuComponent,
  ],
})
export class AppComponent {
  private notificationSheet = inject(NotificationSheetService);
  /** The bell opens notifications as a slide-up sheet over this page. */
  openNotifications(): void {
    void this.notificationSheet.open();
  }

  readonly auth = inject(AuthService);
  readonly cart = inject(CartService);
  readonly preferences = inject(PreferenceService);
  private products = inject(ProductService);
  private router = inject(Router);
  private menu = inject(MenuController);
  private alerts = inject(AlertController);
  private ui = inject(UiService);
  /** Opens the live-updates stream while logged in (notifications, orders, admin data). */
  private live = inject(LiveService);
  private backNav = inject(BackNavService); // starts tracking where each page was opened from

  /** Shown on app launch, but not after the login page's technical Google reload. */
  readonly showSplash = signal(!consumeSkipSplash());
  readonly splashLeaving = signal(false);
  readonly uploadingPhoto = signal(false);

  readonly shopLinks: MenuLink[] = [
    { title: 'Home', url: '/home', icon: 'home-outline' },
    { title: 'All Cookies', url: '/shop', icon: 'cf-cookie' },
    { title: 'Favorites', url: '/profile/favorites', icon: 'heart-outline' },
    { title: 'Cart', url: '/cart', icon: 'cart-outline' },
  ];

  readonly accountLinks: MenuLink[] = [
    { title: 'My Account', url: '/profile', icon: 'person-outline' },
    { title: 'Notifications', url: '/notifications', icon: 'notifications-outline' },
    { title: 'My Orders', url: '/orders', icon: 'receipt-outline' },
    { title: 'My Vouchers', url: '/profile/vouchers', icon: 'ticket-outline' },
    { title: 'My Addresses', url: '/profile/addresses', icon: 'location-outline' },
    { title: 'Settings', url: '/profile/settings', icon: 'settings-outline' },
    { title: 'Help & Support', url: '/help', icon: 'help-circle-outline' },
  ];

  readonly aboutLinks: MenuLink[] = [
    { title: 'Company History', url: '/company-history', icon: 'book-outline' },
    { title: 'About Our Products', url: '/about-products', icon: 'sparkles-outline' },
    { title: 'About the App', url: '/about-app', icon: 'phone-portrait-outline' },
    { title: 'Developers', url: '/developers', icon: 'people-outline' },
    { title: 'Contact Us', url: '/contact', icon: 'chatbubble-ellipses-outline' },
  ];

  private readonly currentUrl = toSignal(
    this.router.events.pipe(
      filter((e): e is NavigationEnd => e instanceof NavigationEnd),
      map((e) => e.urlAfterRedirects),
    ),
    { initialValue: this.router.url },
  );

  readonly activePath = computed(() => this.currentUrl().split('?')[0]);
  /** The dashboard has its own side menu; the shop menu is used everywhere else. */
  readonly onAdmin = computed(() => this.activePath() === '/admin');

  constructor() {
    registerAppIcons();

    // Start loading the menu right away so products are ready the moment the splash ends.
    const menuReady = this.products.load();
    const minDelay = new Promise((r) => setTimeout(r, SPLASH_MIN_MS));
    const maxDelay = new Promise((r) => setTimeout(r, SPLASH_MIN_MS + 2500));
    void Promise.race([Promise.all([menuReady, minDelay]), maxDelay]).then(() => this.hideSplash());

    // Make sure a saved login is still valid.
    this.auth.refreshProfile().catch((err) => {
      if (err instanceof HttpErrorResponse && err.status === 401) this.auth.logout();
    });
  }

  isActive(url: string): boolean {
    return menuLinkIsActive(this.activePath(), url);
  }

  async goToLogin(event: Event): Promise<void> {
    await closeMenuBeforeNavigation(
      event,
      () => this.menu.close(),
      () => this.router.navigate(['/login'], { queryParams: { returnUrl: this.activePath() } }),
      () => this.focusMainContent(),
    );
  }

  /** Superadmin browsing the shop: return to the dashboard. */
  async backToAdmin(): Promise<void> {
    setAdminShopView(false);
    await this.menu.close();
    await this.router.navigateByUrl('/admin', { replaceUrl: true });
  }

  async manageAccount(event: Event): Promise<void> {
    await closeMenuBeforeNavigation(
      event,
      () => this.menu.close(),
      () => this.router.navigateByUrl('/profile'),
      () => this.focusMainContent(),
    );
  }

  async confirmLogout(): Promise<void> {
    const alert = await this.alerts.create({
      header: 'Log out?',
      message: 'Your cart stays saved for the next time you log in.',
      buttons: [
        { text: 'Stay', role: 'cancel' },
        {
          text: 'Log out',
          role: 'destructive',
          handler: () => {
            this.auth.logout();
            void this.menu.close();
            void this.router.navigateByUrl('/home');
            void this.ui.toast('You have been logged out. See you soon!', { icon: 'log-out-outline' });
          },
        },
      ],
    });
    await alert.present();
  }

  async onPhotoPicked(event: Event): Promise<void> {
    const inputEl = event.target as HTMLInputElement;
    const file = inputEl.files?.[0];
    inputEl.value = '';
    if (!file) return;
    this.uploadingPhoto.set(true);
    try {
      const avatar = await fileToAvatar(file);
      await this.auth.updateProfile({ avatar });
      await this.ui.toast('Profile photo updated!', { icon: 'camera-outline' });
    } catch (err) {
      const message = err instanceof Error && !(err instanceof HttpErrorResponse) ? err.message : apiErrorMessage(err);
      await this.ui.toast(message, { error: true });
    } finally {
      this.uploadingPhoto.set(false);
    }
  }

  private hideSplash(): void {
    this.splashLeaving.set(true);
    setTimeout(() => this.showSplash.set(false), 450);
  }

  private focusMainContent(): void {
    document.getElementById('main-content')?.focus({ preventScroll: true });
  }
}
