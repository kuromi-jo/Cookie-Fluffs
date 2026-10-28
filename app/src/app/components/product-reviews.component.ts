/**
 * @file product-reviews.component.ts
 * @description Public reviews on a cookie's page: average, count and the latest customer reviews.
 */
import { Component, effect, inject, input, signal, untracked } from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';
import { IonButton, IonIcon, IonSpinner } from '@ionic/angular';
import { ProductReviews, ReviewService } from '../core/review.service';

@Component({
  selector: 'app-product-reviews',
  imports: [DatePipe, DecimalPipe, IonButton, IonIcon, IonSpinner],
  template: `
    <section class="reviews" aria-labelledby="reviews-heading">
      <div class="head">
        <h2 id="reviews-heading">Customer reviews</h2>
        @if (data(); as d) {
          @if (d.count) {
            <span class="avg"><ion-icon name="star" aria-hidden="true"></ion-icon>{{ d.average | number: '1.1-1' }} · {{ d.count }} {{ d.count === 1 ? 'review' : 'reviews' }}</span>
          }
        }
      </div>
      @if (loading()) {
        <div class="state" role="status"><ion-spinner name="crescent"></ion-spinner></div>
      } @else if (error()) {
        <div class="state" role="alert">
          <p>We couldn’t load reviews right now. Check your connection and try again.</p>
          <ion-button fill="outline" size="small" (click)="load(productId())">Try again</ion-button>
        </div>
      } @else if (data(); as d) {
        @for (r of d.reviews; track r.id) {
          <article class="review" [id]="'review-' + r.id" [class.highlight]="r.id === highlight()" [attr.aria-current]="r.id === highlight() ? 'true' : null">
            <div class="row">
              <strong>{{ r.name }}</strong>
              <span class="stars" [attr.aria-label]="r.rating + ' out of 5 stars'">
                @for (n of five; track n) { <ion-icon [name]="n <= r.rating ? 'star' : 'star-outline'" aria-hidden="true"></ion-icon> }
              </span>
            </div>
            @if (r.comment) { <p>{{ r.comment }}</p> }
            <small><ion-icon name="checkmark-circle" aria-hidden="true"></ion-icon>Verified order · {{ r.createdAt | date: 'mediumDate' }}</small>
          </article>
        } @empty {
          <div class="state empty">
            <ion-icon name="star-outline" aria-hidden="true"></ion-icon>
            <p>No reviews yet. Order this cookie and be the first to rate it.</p>
          </div>
        }
      }
    </section>
  `,
  styles: `
    .reviews { margin-top: 8px; }
    .head { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; flex-wrap: wrap; }
    h2 { margin: 22px 0 10px; font-family: var(--cf-font-display); font-size: 1.15rem; color: var(--cf-choco); }
    .avg { display: inline-flex; align-items: center; gap: 4px; font-size: .82rem; font-weight: 800; color: var(--cf-choco); }
    .avg ion-icon, .stars ion-icon { color: var(--ion-color-warning); }
    .review { padding: 12px 14px; margin-bottom: 8px; border: 1px solid var(--cf-pink-border); border-radius: 20px; background: #fff; }
    .review.highlight { border-color: var(--cf-pink-accent); background: var(--cf-pink-card); outline: 2px solid var(--cf-pink-accent); outline-offset: 2px; animation: glow 1.2s ease-in-out 3; }
    @keyframes glow { 50% { background: var(--cf-pink-soft); outline-color: var(--cf-pink-deep); } }
    @media (prefers-reduced-motion: reduce) { .review.highlight { animation: none; } }
    .row { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
    .row strong { font-size: .9rem; color: var(--cf-choco); }
    .stars { display: inline-flex; gap: 2px; font-size: .85rem; }
    .review p { margin: 6px 0; font-size: .88rem; line-height: 1.45; color: var(--cf-choco-medium); overflow-wrap: anywhere; }
    .review small { display: inline-flex; align-items: center; gap: 4px; font-size: .72rem; font-weight: 600; color: var(--cf-choco-light); }
    .review small ion-icon { color: var(--ion-color-success); }
    .state { display: grid; justify-items: center; gap: 6px; padding: 16px; text-align: center; font-size: .86rem; color: var(--cf-choco-medium); }
    .state p { margin: 0; }
    .empty { border: 1px dashed var(--cf-pink-border); border-radius: 20px; background: var(--cf-pink-soft); }
    .empty ion-icon { font-size: 1.6rem; color: var(--cf-pink-deep); }
  `,
})
export class ProductReviewsComponent {
  readonly productId = input.required<number>();
  /** Review id to scroll to and highlight (opened from the admin's notifications or Reviews tab). */
  readonly highlight = input<string | null>(null);

  private reviews = inject(ReviewService);
  readonly five = [1, 2, 3, 4, 5];
  readonly data = signal<ProductReviews | null>(null);
  readonly loading = signal(true);
  readonly error = signal(false);

  constructor() {
    effect(() => void this.load(this.productId()));
  }

  /** Centers the highlighted review inside the page's ion-content. */
  private async scrollTo(reviewId: string): Promise<void> {
    const el = document.getElementById(`review-${reviewId}`);
    const content = el?.closest('ion-content');
    if (!el || !content) return;
    const scroller = await content.getScrollElement();
    const y = el.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop
      - scroller.clientHeight / 2 + el.offsetHeight / 2;
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    await content.scrollToPoint(0, Math.max(0, y), reduce ? 0 : 600);
  }

  async load(id: number): Promise<void> {
    this.loading.set(true);
    this.error.set(false);
    try {
      const d = await this.reviews.forProduct(id);
      if (id === this.productId()) {
        this.data.set(d);
        const target = untracked(() => this.highlight());
        if (target) setTimeout(() => void this.scrollTo(target), 400);
      }
    } catch {
      if (id === this.productId()) this.error.set(true);
    } finally {
      if (id === this.productId()) this.loading.set(false);
    }
  }
}
