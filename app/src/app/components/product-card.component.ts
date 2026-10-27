/**
 * @file product-card.component.ts
 * @description One cookie tile (Home sections and the All Cookies grid):
 * the cookie picture sits half outside a white card, with name, notes, price and a cart button.
 */
import { Component, computed, inject, input, output } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import { IonIcon, IonSpinner } from '@ionic/angular';
import { Product, discountPercent } from '../core/models';
import { FavoriteService } from '../core/favorite.service';

@Component({
  selector: 'app-product-card',
  imports: [RouterLink, DecimalPipe, IonIcon, IonSpinner],
  template: `
    @let p = product();
    <article class="card">
      <button
        type="button"
        class="favorite"
        [class.saved]="favorites.isFavorite(p.id)"
        [disabled]="favorites.isBusy(p.id)"
        [attr.aria-pressed]="favorites.isFavorite(p.id)"
        [attr.aria-label]="favorites.isFavorite(p.id) ? 'Remove ' + p.name + ' from favorites' : 'Save ' + p.name + ' to favorites'"
        (click)="saveFavorite(p)"
      >
        @if (favorites.isBusy(p.id)) {
          <ion-spinner name="crescent"></ion-spinner>
        } @else {
          <ion-icon [name]="favorites.isFavorite(p.id) ? 'heart' : 'heart-outline'" aria-hidden="true"></ion-icon>
        }
      </button>
      <a class="media" [routerLink]="['/product', p.id]" [attr.aria-label]="'View ' + p.name">
        <img [src]="p.imageUrl" [alt]="p.name" loading="lazy" />
      </a>
      @if (discount()) {
        <span class="sticker promo">-{{ discount() }}%</span>
      } @else if (p.season === 'halloween') {
        <span class="sticker seasonal" role="img" aria-label="Halloween special"><ion-icon name="moon" aria-hidden="true"></ion-icon></span>
      } @else if (p.isNew) {
        <span class="sticker new">New</span>
      }

      <div class="panel">
        <a class="name" [routerLink]="['/product', p.id]">{{ p.name }}</a>
        <p class="notes">{{ p.flavorNotes }}</p>
        <div class="row">
          <span class="price">
            @if (p.salePrice !== null) {
              <s>₱{{ p.price | number: '1.0-0' }}</s>
              <span class="now"><small>₱</small>{{ p.salePrice | number: '1.0-0' }}</span>
            } @else {
              <span><small>₱</small>{{ p.price | number: '1.0-0' }}</span>
            }
          </span>
          <button
            type="button"
            class="add"
            [class.in-cart]="inCart() > 0"
            [disabled]="busy() || !p.isAvailable"
            (click)="add.emit(p)"
            [attr.aria-label]="!p.isAvailable ? p.name + ' is unavailable' : inCart() > 0 ? 'Add more ' + p.name + ' (' + inCart() + ' in cart)' : 'Add ' + p.name + ' to cart'"
          >
            @if (!p.isAvailable) {
              <ion-icon name="close" aria-hidden="true"></ion-icon>
            } @else if (busy()) {
              <ion-spinner name="crescent"></ion-spinner>
            } @else {
              <ion-icon name="cart-outline"></ion-icon>
              @if (inCart() > 0) {
                <span class="qty">{{ inCart() }}</span>
              }
            }
          </button>
        </div>
      </div>
    </article>
  `,
  styles: `
    :host { display: block; }
    .card { position: relative; display: flex; flex-direction: column; height: 100%; }
    .favorite {
      position: absolute; z-index: 4; top: 2px; left: 2px; display: grid; place-items: center;
      width: 44px; height: 44px; padding: 0; border: 1px solid var(--cf-pink-border); border-radius: 50%;
      background: #fff; color: var(--cf-pink-deep); cursor: pointer;
    }
    .favorite.saved { background: var(--cf-pink-soft); }
    .favorite:focus-visible { outline: 0; box-shadow: 0 0 0 4px rgba(244, 114, 182, 0.18); }
    .favorite ion-icon { font-size: 21px; }
    .favorite ion-spinner { width: 18px; height: 18px; }

    /* Cookie picture, overlapping the top of the white panel */
    .media {
      position: relative; z-index: 1; display: block; width: 82%; aspect-ratio: 1;
      margin: 0 auto -38%;
    }
    .media img {
      width: 100%; height: 100%; object-fit: contain;
      transition: transform .35s cubic-bezier(.34, 1.4, .64, 1);
    }
    .card:hover .media img { transform: rotate(-8deg) scale(1.03); }
    /* tap = a playful half spin */
    .card:active .media img { transform: rotate(180deg) scale(.94); transition-duration: .5s; }

    .sticker {
      position: absolute; z-index: 2; top: 2%; right: 2%;
      display: grid; place-items: center; width: 42px; height: 42px; border-radius: 50%;
      font-size: .7rem; font-weight: 800; color: #fff; transform: rotate(10deg);
    }
    .sticker.promo { background: var(--cf-pink-deep); }
    .sticker.new { background: var(--cf-choco-btn); color: #fff5f7; }
    .sticker.seasonal { background: var(--cf-pink-accent); color: var(--cf-choco); font-size: 1.15rem; }

    .panel {
      flex: 1; display: flex; flex-direction: column;
      padding: calc(38% + 12px) 14px 14px;
      border-radius: 26px; background: #fff;
    }
    .name {
      font-family: var(--cf-font-display); font-weight: 800; font-size: 1.06rem; line-height: 1.18;
      color: var(--cf-choco); text-decoration: none;
      display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
    }
    .notes { margin: 4px 0 12px; font-size: .74rem; font-weight: 600; color: var(--cf-choco-light); }
    .row { margin-top: auto; display: flex; align-items: flex-end; justify-content: space-between; gap: 6px; }
    .price { display: flex; flex-direction: column; font-size: 1.2rem; font-weight: 800; color: var(--cf-choco); line-height: 1.05; }
    .price small { font-size: .85rem; margin-right: 1px; }
    .price s { font-size: .74rem; font-weight: 600; color: var(--cf-choco-light); }
    .price .now { color: var(--cf-pink-deep); }

    .add {
      position: relative; display: grid; place-items: center; flex: none; width: 44px; height: 44px;
      border: 0; border-radius: 15px; background: var(--cf-choco-btn); color: #fff5f7; font-size: 21px; cursor: pointer;
      transition: transform .15s ease, background .2s ease;
    }
    .add:active { transform: scale(.9); }
    .add.in-cart { background: var(--cf-pink-vibrant); }
    .add:disabled { opacity: .55; cursor: default; }
    .add ion-spinner { width: 18px; height: 18px; color: #fff; }
    .qty {
      position: absolute; top: -6px; right: -6px; min-width: 20px; height: 20px; padding: 0 5px;
      border-radius: 999px; background: #fff; color: var(--cf-pink-deep); border: 1.5px solid var(--cf-pink-vibrant);
      font-size: .66rem; font-weight: 800; line-height: 17px; box-sizing: border-box;
    }
  `,
})
export class ProductCardComponent {
  readonly favorites = inject(FavoriteService);
  readonly product = input.required<Product>();
  readonly inCart = input(0);
  readonly busy = input(false);
  readonly add = output<Product>();

  readonly discount = computed(() => discountPercent(this.product()));

  saveFavorite(product: Product): void {
    void this.favorites.toggle(product);
  }
}
