/**
 * @file pack-options.component.ts
 * @description "How many?" choice: Single, Box of 4, Box of 6 or Box of 12.
 * Used in the add-to-cart sheet and on the product page.
 */
import { Component, computed, input, model } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { PACK_OPTIONS, PackSize, Product, effectivePrice } from '../core/models';

@Component({
  selector: 'app-pack-options',
  imports: [DecimalPipe],
  template: `
    <div class="options" role="radiogroup" aria-label="Choose a pack">
      @for (o of rows(); track o.size) {
        <button
          type="button"
          class="option"
          role="radio"
          [class.on]="selected() === o.size"
          [attr.aria-checked]="selected() === o.size"
          (click)="selected.set(o.size)"
        >
          <span class="art" [attr.data-size]="o.size" aria-hidden="true">
            @if (o.size === 1) {
              <img [src]="thumb()" alt="" />
            } @else {
              @for (d of dots(o.size); track $index) {
                <i></i>
              }
            }
          </span>
          <span class="text">
            <strong>{{ o.label }}</strong>
            <small>{{ o.hint }}</small>
          </span>
          <span class="price">
            @if (o.discountPercent) {
              <em>Save {{ o.discountPercent }}%</em>
              <small>from</small>
            }
            ₱{{ o.from | number: '1.0-0' }}
          </span>
        </button>
      }
    </div>
  `,
  styles: `
    .options { display: grid; gap: 8px; }
    .option {
      display: flex; align-items: center; gap: 12px; width: 100%; padding: 10px 14px 10px 10px;
      border: 1.5px solid var(--cf-pink-border); border-radius: 18px; background: #fff;
      color: var(--cf-choco); font: inherit; text-align: left; cursor: pointer;
      transition: border-color .15s ease, background .15s ease;
    }
    .option.on { border-color: var(--cf-pink-vibrant); background: var(--cf-pink-card); }
    .art {
      display: grid; place-items: center; flex: none; width: 44px; height: 44px;
      border-radius: 12px; background: var(--cf-pink-soft); padding: 6px; box-sizing: border-box; gap: 3px;
    }
    .option.on .art { background: #fbcfe8; }
    .art img { width: 100%; height: 100%; object-fit: contain; }
    .art[data-size='4'] { grid-template-columns: repeat(2, 1fr); }
    .art[data-size='6'] { grid-template-columns: repeat(3, 1fr); }
    .art[data-size='12'] { grid-template-columns: repeat(4, 1fr); }
    .art i { display: block; width: 100%; aspect-ratio: 1; border-radius: 50%; background: var(--cf-choco-light); }
    .option.on .art i { background: var(--cf-choco-btn); }
    .text { flex: 1; display: flex; flex-direction: column; min-width: 0; }
    .text strong { font-size: .95rem; font-weight: 800; }
    .text small { font-size: .74rem; font-weight: 600; color: var(--cf-choco-light); }
    .price { display: flex; flex-direction: column; align-items: flex-end; font-weight: 800; font-size: .95rem; line-height: 1.15; }
    .price em { font-style: normal; font-size: .64rem; font-weight: 800; color: #fff; background: var(--cf-pink-deep); padding: 2px 7px; border-radius: 999px; margin-bottom: 2px; }
    .price small { font-size: .62rem; font-weight: 600; color: var(--cf-choco-light); }
  `,
})
export class PackOptionsComponent {
  readonly product = input.required<Product>();
  readonly selected = model<PackSize>(1);

  readonly thumb = computed(() => this.product().imageUrl.replace('assets/cookies/', 'assets/cookies/thumbs/'));

  /** Each option with its starting price: the box filled with this cookie, after the box discount. */
  readonly rows = computed(() => {
    const unit = effectivePrice(this.product());
    return PACK_OPTIONS.map((o) => ({ ...o, from: Math.round(unit * o.size * (1 - o.discountPercent / 100)) }));
  });

  dots(n: number): number[] {
    return Array.from({ length: n }, (_, i) => i);
  }
}
