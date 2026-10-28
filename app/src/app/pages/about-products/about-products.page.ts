/**
 * @file about-products.page.ts
 * @description What goes into a Cookie Fluffs cookie, plus the menu grouped by category (live from Neon).
 */
import { Component, computed, inject } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import {
  IonButtons,
  IonContent,
  IonHeader,
  IonIcon,
  IonMenuButton,
  IonTitle,
  IonToolbar,
} from '@ionic/angular';
import { ProductService } from '../../core/product.service';
import { CATEGORIES } from '../../core/models';
import { PhotoPipe } from '../../core/photo.pipe';
import { AsyncPipe } from '@angular/common';

const CATEGORY_BLURBS: Record<string, string> = {
  classic: 'The timeless favorites that started it all, plus our sprinkle-topped sugar cookies.',
  indulgent: 'Rich, chocolatey and a little extra.',
  fruity: 'Strawberry, mango, ube, lime and banana bakes.',
  nutty: 'Peanut butter and salted caramel favorites.',
  dietary: 'Simple, lighter bakes without the frosting.',
};

@Component({
  selector: 'app-about-products',
  templateUrl: 'about-products.page.html',
  styleUrls: ['../info-page.scss', 'about-products.page.scss'],
  imports: [PhotoPipe, AsyncPipe, RouterLink, DecimalPipe, IonHeader, IonToolbar, IonButtons, IonMenuButton, IonTitle, IonContent, IonIcon],
})
export class AboutProductsPage {
  readonly products = inject(ProductService);

  readonly groups = computed(() =>
    CATEGORIES.filter((c) => c.id !== 'all').map((c) => {
      const items = this.products.products().filter((p) => p.category === c.id);
      const prices = items.map((p) => p.price);
      return {
        ...c,
        blurb: CATEGORY_BLURBS[c.id] ?? '',
        items,
        from: prices.length ? Math.min(...prices) : 0,
      };
    }),
  );

  /** Hero picture: our current #1 best seller (same ranking as Best sellers), or the classic. */
  readonly heroCookie = computed(() => {
    const ranked = [...this.products.products()].filter((p) => p.bestRank).sort((a, b) => (a.bestRank ?? 99) - (b.bestRank ?? 99));
    const top = ranked[0] ?? this.products.products().find((p) => p.slug === 'choco-chip');
    return top ? { src: top.imageUrl, name: top.name } : { src: 'assets/cookies/choco-chip.webp', name: 'Classic Choco Chip' };
  });

  readonly promises = [
    { icon: 'ribbon-outline', title: 'Real ingredients', text: 'Real butter, rich chocolate, local ube and sweet Philippine mango.' },
    { icon: 'time-outline', title: 'Baked fresh daily', text: 'Every order comes from that morning\'s batch. Never frozen.' },
    { icon: 'resize-outline', title: 'Jumbo 4.5" size', text: 'Thick, about 110 g each, and big enough to share (or not).' },
    { icon: 'gift-outline', title: 'Gift-ready boxes', text: 'Packed in our pink signature box with a handwritten note.' },
  ];

  constructor() {
    void this.products.load();
  }
}
