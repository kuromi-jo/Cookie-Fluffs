/**
 * @file app.component.ts
 * @description App shell: splash screen, side menu and the router outlet.
 */
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
import { fileToAvatar } from './core/image';
import { apiErrorMessage } from './core/api-error';

interface MenuLink {
  title: string;
  url: string;
  icon: string;
  note?: string;
}

const SPLASH_MIN_MS = 2400;

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
  ],
})
export class AppComponent {
  readonly auth = inject(AuthService);
  readonly cart = inject(CartService);
  private products = inject(ProductService);
  private router = inject(Router);
  private menu = inject(MenuController);
  private alerts = inject(AlertController);
  private ui = inject(UiService);

  readonly showSplash = signal(true);
  readonly splashLeaving = signal(false);
  readonly uploadingPhoto = signal(false);

  readonly shopLinks: MenuLink[] = [
    { title: 'Home', url: '/home', icon: 'home-outline' },
    { title: 'All Cookies', url: '/shop', icon: 'cf-cookie' },
    { title: 'Cart', url: '/cart', icon: 'cart-outline' },
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
    return this.activePath() === url || (url === '/home' && this.activePath().startsWith('/product/'));
  }

  goToLogin(): void {
    void this.menu.close();
    void this.router.navigate(['/login'], { queryParams: { returnUrl: this.activePath() } });
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
}
