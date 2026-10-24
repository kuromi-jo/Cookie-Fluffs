/**
 * @file favorites.page.ts
 * @description Authenticated collection of the customer's saved cookies.
 */
import { Component, inject } from '@angular/core';
import { Router } from '@angular/router';
import { RouterLink } from '@angular/router';
import {
  IonBackButton,
  IonButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonIcon,
  IonSkeletonText,
  IonTitle,
  IonToolbar,
} from '@ionic/angular';
import { ProductCardComponent } from '../../components/product-card.component';
import { AuthService } from '../../core/auth.service';
import { CartService } from '../../core/cart.service';
import { FavoriteService } from '../../core/favorite.service';
import { Product } from '../../core/models';
import { ShopActionsService } from '../../core/shop-actions.service';

@Component({
  selector: 'app-favorites',
  templateUrl: 'favorites.page.html',
  styleUrls: ['../catalog.scss', 'favorites.page.scss'],
  imports: [
    ProductCardComponent,
    RouterLink,
    IonHeader,
    IonToolbar,
    IonButtons,
    IonBackButton,
    IonTitle,
    IonContent,
    IonButton,
    IonIcon,
    IonSkeletonText,
  ],
})
export class FavoritesPage {
  readonly favorites = inject(FavoriteService);
  readonly cart = inject(CartService);
  private auth = inject(AuthService);
  private shop = inject(ShopActionsService);
  private router = inject(Router);
  readonly skeletons = [1, 2, 3, 4];

  async ionViewWillEnter(): Promise<void> {
    if (!this.auth.isLoggedIn()) {
      await this.router.navigate(['/login'], {
        queryParams: { returnUrl: '/profile/favorites' },
        replaceUrl: true,
      });
      return;
    }
    await this.favorites.load(true).catch(() => undefined);
  }

  retry(): void {
    void this.favorites.load(true).catch(() => undefined);
  }

  addToCart(product: Product): void {
    if (product.isAvailable) void this.shop.choosePack(product);
  }
}
