/**
 * @file order-review.component.ts
 * @description "How were your cookies?" card on a completed order: star rating and an optional comment
 * for each cookie in the order. Reviews are public on each cookie's page.
 */
import { Component, effect, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { IonButton, IonIcon, IonSpinner, IonToggle } from '@ionic/angular';
import { ReviewService, ReviewableCookie } from '../core/review.service';
import { UiService } from '../core/ui.service';
import { apiErrorMessage } from '../core/api-error';
import { PhotoPipe } from '../core/photo.pipe';
import { AsyncPipe } from '@angular/common';

interface Draft {
  rating: number;
  comment: string;
  anonymous: boolean;
  editing: boolean;
  saving: boolean;
  error: string;
}

@Component({
  selector: 'app-order-review',
  imports: [PhotoPipe, AsyncPipe, FormsModule, RouterLink, IonButton, IonIcon, IonSpinner, IonToggle],
  template: `
    @if (items().length) {
      <section class="review-card" aria-labelledby="review-heading">
        <p class="cf-eyebrow">Your order is complete</p>
        <h2 id="review-heading">How were your cookies?</h2>
        <p class="lead">Your rating shows on each cookie’s page so other customers know what to expect.</p>
        @for (c of items(); track c.productId) {
          @let d = draft(c);
          <article class="cookie">
            <div class="top">
              <img [src]="c.imageUrl | cfPhoto | async" [alt]="" (error)="hide($event)" />
              <a [routerLink]="['/product', c.productId]">{{ c.name }}</a>
            </div>
            @if (c.review && !d.editing) {
              <div class="done">
                <span class="stars" [attr.aria-label]="c.review.rating + ' out of 5 stars'">
                  @for (n of five; track n) { <ion-icon [name]="n <= c.review.rating ? 'star' : 'star-outline'" aria-hidden="true"></ion-icon> }
                </span>
                <span class="thanks"><ion-icon name="checkmark-circle" aria-hidden="true"></ion-icon>{{ c.review.anonymous ? 'Posted anonymously' : 'Thanks for your review' }}</span>
                <ion-button fill="clear" size="small" (click)="patch(c, { editing: true })">Edit</ion-button>
              </div>
              @if (c.review.comment) { <p class="said">{{ c.review.comment }}</p> }
            } @else {
              <div class="rate" role="radiogroup" [attr.aria-label]="'Rate ' + c.name">
                @for (n of five; track n) {
                  <button type="button" role="radio" [attr.aria-checked]="d.rating === n" [attr.aria-label]="n + (n === 1 ? ' star' : ' stars')" (click)="patch(c, { rating: n, error: '' })">
                    <ion-icon [name]="n <= d.rating ? 'star' : 'star-outline'" aria-hidden="true"></ion-icon>
                  </button>
                }
              </div>
              <label class="note">
                <span>Tell us more (optional)</span>
                <textarea rows="2" maxlength="500" [ngModel]="d.comment" (ngModelChange)="patch(c, { comment: $event })" placeholder="Soft, chewy, just right?"></textarea>
              </label>
              <ion-toggle class="anon" labelPlacement="start" justify="space-between" [checked]="d.anonymous" (ionChange)="patch(c, { anonymous: $event.detail.checked })">
                <span class="anon-label"><strong>Post anonymously</strong><small>{{ d.anonymous ? 'Shown as “Anonymous customer”' : 'Your first name is shown with your review' }}</small></span>
              </ion-toggle>
              @if (d.error) { <p class="field-error" role="alert"><ion-icon name="alert-circle" aria-hidden="true"></ion-icon>{{ d.error }}</p> }
              <ion-button expand="block" (click)="submit(c)" [disabled]="d.saving">
                @if (d.saving) { <ion-spinner name="crescent"></ion-spinner> } @else { Post review }
              </ion-button>
            }
          </article>
        }
      </section>
    }
  `,
  styles: `
    .review-card { margin: 0 0 16px; padding: 18px 16px; border: 1px solid var(--cf-pink-border); border-radius: 20px; background: var(--cf-pink-soft); }
    h2 { margin: 2px 0 4px; font-family: var(--cf-font-display); font-size: 1.2rem; color: var(--cf-choco); }
    .lead { margin: 0 0 12px; font-size: .84rem; color: var(--cf-choco-medium); }
    .cookie { padding: 12px; margin-top: 10px; border-radius: 20px; background: #fff; border: 1px solid var(--cf-pink-border); }
    .top { display: flex; align-items: center; gap: 10px; }
    .top img { width: 44px; height: 44px; border-radius: 12px; object-fit: cover; background: var(--cf-pink-soft); }
    .top a { font-weight: 800; color: var(--cf-choco); text-decoration: none; }
    .rate { display: flex; gap: 2px; margin: 8px 0 4px; }
    .rate button { display: grid; place-items: center; width: 44px; height: 44px; padding: 0; border: 0; border-radius: 999px; background: none; font-size: 1.6rem; color: var(--ion-color-warning); cursor: pointer; }
    .rate button:focus-visible { outline: none; box-shadow: 0 0 0 3px var(--cf-pink-accent); }
    .note { display: grid; gap: 4px; margin-bottom: 10px; font-size: .78rem; font-weight: 700; color: var(--cf-choco-medium); }
    textarea { box-sizing: border-box; width: 100%; padding: 10px 14px; border: 1.5px solid var(--cf-pink-border); border-radius: 12px; font: inherit; font-weight: 500; font-size: .9rem; color: var(--cf-choco); background: #fff; resize: vertical; }
    textarea:focus { outline: none; border-color: var(--cf-pink-accent); box-shadow: 0 0 0 3px var(--cf-pink-soft); }
    .done { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-top: 8px; }
    .stars { display: inline-flex; gap: 2px; color: var(--ion-color-warning); }
    .thanks { display: inline-flex; align-items: center; gap: 4px; font-size: .78rem; font-weight: 700; color: var(--cf-choco-medium); }
    .thanks ion-icon { color: var(--ion-color-success); }
    .done ion-button { margin-left: auto; }
    .said { margin: 6px 0 0; font-size: .86rem; color: var(--cf-choco-medium); overflow-wrap: anywhere; }
    .anon { --track-background-checked: var(--cf-choco-btn); width: 100%; min-height: 44px; margin-bottom: 10px; }
    .anon-label { display: flex; flex-direction: column; white-space: normal; }
    .anon-label strong { font-size: .86rem; color: var(--cf-choco); }
    .anon-label small { font-size: .74rem; font-weight: 600; color: var(--cf-choco-light); }
    .field-error { display: flex; align-items: center; gap: 6px; margin: 0 0 8px; font-size: .8rem; font-weight: 700; color: var(--ion-color-danger); }
  `,
})
export class OrderReviewComponent {
  readonly orderId = input.required<string>();
  /** Reviews open once the order is completed; the card reloads when the status changes. */
  readonly status = input.required<string>();

  private reviews = inject(ReviewService);
  private ui = inject(UiService);
  readonly five = [1, 2, 3, 4, 5];
  readonly items = signal<ReviewableCookie[]>([]);
  private readonly drafts = signal<Record<number, Draft>>({});

  constructor() {
    effect(() => {
      const id = this.orderId();
      if (this.status() !== 'completed') {
        this.items.set([]);
        return;
      }
      void this.reviews
        .forOrder(id)
        .then((r) => {
          if (id === this.orderId()) this.items.set(r.canReview ? r.items : []);
        })
        .catch(() => undefined); // the card simply stays hidden; the rest of the order still works
    });
  }

  draft(c: ReviewableCookie): Draft {
    return this.drafts()[c.productId] ?? { rating: c.review?.rating ?? 0, comment: c.review?.comment ?? '', anonymous: c.review?.anonymous ?? false, editing: false, saving: false, error: '' };
  }

  patch(c: ReviewableCookie, change: Partial<Draft>): void {
    this.drafts.update((all) => ({ ...all, [c.productId]: { ...this.draft(c), ...change } }));
  }

  async submit(c: ReviewableCookie): Promise<void> {
    const d = this.draft(c);
    if (!d.rating) {
      this.patch(c, { error: 'Tap a star to rate this cookie.' });
      return;
    }
    this.patch(c, { saving: true, error: '' });
    try {
      const saved = await this.reviews.submit(this.orderId(), c.productId, d.rating, d.comment.trim(), d.anonymous);
      this.items.update((list) => list.map((i) => (i.productId === c.productId ? { ...i, review: saved } : i)));
      this.patch(c, { saving: false, editing: false });
      void this.ui.toast(`Thanks! Your review of ${c.name} is posted.`, { icon: 'star' });
    } catch (err) {
      this.patch(c, { saving: false, error: apiErrorMessage(err) });
    }
  }

  hide(event: Event): void {
    (event.currentTarget as HTMLImageElement).style.visibility = 'hidden';
  }
}
