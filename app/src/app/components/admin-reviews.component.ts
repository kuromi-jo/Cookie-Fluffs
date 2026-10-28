/**
 * @file admin-reviews.component.ts
 * @description Admin "Reviews" tab: every customer review, read only (customers own their reviews).
 * Search by reviewer or comment, filter by cookie and star rating. Tapping a review opens the cookie's
 * page with that review highlighted.
 */
import { Component, computed, inject, signal } from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';
import { IonButton, IonIcon, IonSearchbar, IonSelect, IonSelectOption, IonSpinner, NavController } from '@ionic/angular';
import { AdminReview, AdminService } from '../core/admin.service';
import { PhotoPipe } from '../core/photo.pipe';
import { AsyncPipe } from '@angular/common';

@Component({
  selector: 'app-admin-reviews',
  imports: [PhotoPipe, AsyncPipe, DatePipe, DecimalPipe, IonButton, IonIcon, IonSearchbar, IonSelect, IonSelectOption, IonSpinner],
  template: `
    @if (admin.reviews(); as r) {
      <section class="summary cf-card" aria-label="Review summary">
        <div><strong><ion-icon name="star" aria-hidden="true"></ion-icon>{{ r.average | number: '1.1-1' }}</strong><span>Average rating</span></div>
        <div><strong>{{ r.count }}</strong><span>{{ r.count === 1 ? 'Review' : 'Reviews' }}</span></div>
      </section>
      <p class="note"><ion-icon name="lock-closed-outline" aria-hidden="true"></ion-icon>Reviews belong to customers and can't be edited or removed here.</p>
      <div class="tools">
        <ion-searchbar class="search" placeholder="Search reviewer or comment" [debounce]="200" [value]="q()" (ionInput)="q.set($event.detail.value ?? '')" aria-label="Search reviews"></ion-searchbar>
        <div class="two">
          <ion-select class="cf-input" label="Cookie" labelPlacement="floating" interface="popover" [value]="product()" (ionChange)="product.set($event.detail.value)">
            <ion-select-option [value]="0">All cookies</ion-select-option>
            @for (c of cookies(); track c.id) { <ion-select-option [value]="c.id">{{ c.name }}</ion-select-option> }
          </ion-select>
          <ion-select class="cf-input" label="Stars" labelPlacement="floating" interface="popover" [value]="stars()" (ionChange)="stars.set($event.detail.value)">
            <ion-select-option [value]="0">All ratings</ion-select-option>
            @for (n of [5, 4, 3, 2, 1]; track n) { <ion-select-option [value]="n">{{ n }} {{ n === 1 ? 'star' : 'stars' }}</ion-select-option> }
          </ion-select>
        </div>
        <p class="shown" role="status">Showing {{ shown().length }} of {{ r.reviews.length }}</p>
      </div>
      @for (rv of shown(); track rv.id) {
        <button type="button" class="review cf-card" (click)="open(rv)" [attr.aria-label]="'Open ' + rv.productName + ' review by ' + who(rv)">
          <img [src]="rv.imageUrl | cfPhoto | async" alt="" (error)="hide($event)" />
          <span class="body">
            <span class="top">
              <strong>{{ rv.productName }}</strong>
              <span class="stars" [attr.aria-label]="rv.rating + ' out of 5 stars'">
                @for (n of five; track n) { <ion-icon [name]="n <= rv.rating ? 'star' : 'star-outline'" aria-hidden="true"></ion-icon> }
              </span>
            </span>
            @if (rv.comment) { <span class="comment">{{ rv.comment }}</span> }
            <small>{{ who(rv) }} · {{ rv.createdAt | date: 'MMM d, h:mm a' }}</small>
          </span>
          <ion-icon class="go" name="chevron-forward" aria-hidden="true"></ion-icon>
        </button>
      } @empty {
        @if (r.reviews.length) {
          <div class="empty cf-card">
            <ion-icon name="search-outline" aria-hidden="true"></ion-icon>
            <h3>No reviews match</h3>
            <p>Try another name, cookie or star rating.</p>
            <ion-button fill="outline" (click)="clear()">Clear search and filters</ion-button>
          </div>
        } @else {
        <div class="empty cf-card">
          <ion-icon name="star-outline" aria-hidden="true"></ion-icon>
          <h3>No reviews yet</h3>
          <p>Customers are asked to rate their cookies when an order is completed. Reviews show up here instantly.</p>
          <ion-button fill="outline" (click)="admin.tab.set('orders')">Go to orders</ion-button>
        </div>
        }
      }
    } @else {
      <div class="center" role="status"><ion-spinner name="crescent"></ion-spinner></div>
    }
  `,
  styles: `
    .summary { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; padding: 14px; margin-bottom: 10px; }
    .summary div { display: flex; flex-direction: column; align-items: center; }
    .summary strong { display: inline-flex; align-items: center; gap: 4px; font-family: var(--cf-font-display); font-size: 1.5rem; color: var(--cf-choco); }
    .summary strong ion-icon { font-size: 1.1rem; color: var(--ion-color-warning); }
    .summary span { font-size: .74rem; font-weight: 700; color: var(--cf-choco-light); }
    .tools { display: grid; gap: 8px; margin-bottom: 10px; }
    .search { --background: #fff; --border-radius: 999px; --placeholder-color: var(--cf-choco-light); padding: 0; }
    .two { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
    .two ion-select { margin: 0; }
    .shown { margin: 0 2px; font-size: .74rem; font-weight: 700; color: var(--cf-choco-light); }
    .note { display: flex; align-items: center; gap: 6px; margin: 0 0 12px; font-size: .76rem; font-weight: 600; color: var(--cf-choco-medium); }
    .review { display: flex; align-items: flex-start; gap: 12px; box-sizing: border-box; width: 100%; margin-bottom: 8px; padding: 12px 14px; border: 1px solid var(--cf-pink-border); font: inherit; text-align: left; color: var(--cf-choco); cursor: pointer; }
    .review:focus-visible { outline: none; box-shadow: 0 0 0 3px var(--cf-pink-accent); }
    .review img { flex: none; width: 48px; height: 48px; border-radius: 12px; object-fit: cover; background: var(--cf-pink-soft); }
    .body { display: flex; flex: 1; flex-direction: column; gap: 3px; min-width: 0; }
    .top { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
    .top strong { font-size: .9rem; }
    .stars { display: inline-flex; flex: none; gap: 1px; font-size: .8rem; color: var(--ion-color-warning); }
    .comment { font-size: .84rem; line-height: 1.4; color: var(--cf-choco-medium); overflow-wrap: anywhere; }
    .body small { font-size: .72rem; font-weight: 600; color: var(--cf-choco-light); }
    .go { flex: none; align-self: center; color: var(--cf-choco-light); }
    .empty { display: grid; justify-items: center; gap: 6px; padding: 28px 20px; text-align: center; }
    .empty > ion-icon { padding: 14px; border-radius: 20px; background: var(--cf-pink-soft); color: var(--cf-pink-deep); font-size: 28px; }
    .empty h3 { margin: 4px 0 0; font-family: var(--cf-font-display); color: var(--cf-choco); }
    .empty p { margin: 0 0 6px; font-size: .86rem; color: var(--cf-choco-medium); }
    .center { display: grid; place-items: center; padding: 40px; }
  `,
})
export class AdminReviewsComponent {
  readonly admin = inject(AdminService);
  private nav = inject(NavController);
  readonly five = [1, 2, 3, 4, 5];
  readonly q = signal('');
  /** Selected cookie id (0 = all) and star rating (0 = all). */
  readonly product = signal(0);
  readonly stars = signal(0);

  /** Cookies that have at least one review, for the filter. */
  readonly cookies = computed(() => {
    const seen = new Map<number, string>();
    for (const rv of this.admin.reviews()?.reviews ?? []) seen.set(rv.productId, rv.productName);
    return [...seen].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
  });

  readonly shown = computed(() => {
    const q = this.q().trim().toLowerCase();
    return (this.admin.reviews()?.reviews ?? []).filter((rv) =>
      (!this.product() || rv.productId === this.product())
      && (!this.stars() || rv.rating === this.stars())
      && (!q || rv.customerName.toLowerCase().includes(q) || (rv.comment ?? '').toLowerCase().includes(q)
        || rv.productName.toLowerCase().includes(q)));
  });

  clear(): void {
    this.q.set('');
    this.product.set(0);
    this.stars.set(0);
  }

  /** The admin sees who wrote it; anonymous reviews are labelled so the admin knows customers see them as anonymous. */
  who(rv: AdminReview): string {
    return rv.anonymous ? `${rv.customerName} (posted anonymously)` : rv.customerName;
  }

  open(rv: AdminReview): void {
    void this.nav.navigateForward(['/product', rv.productId], { queryParams: { review: rv.id } });
  }

  hide(event: Event): void {
    (event.currentTarget as HTMLImageElement).style.visibility = 'hidden';
  }
}
