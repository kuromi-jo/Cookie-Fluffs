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

const CATEGORY_BLURBS: Record<string, string> = {
  classic: 'The timeless favorites that started it all.',
  indulgent: 'Rich, decadent and a little extra.',
  fruity: 'Bright berries and fruity swirls.',
  nutty: 'Toasted nuts and golden caramel.',
  dietary: 'Lighter bites, vegan and refined-sugar-free.',
};

@Component({
  selector: 'app-about-products',
  templateUrl: 'about-products.page.html',
  styleUrls: ['../info-page.scss', 'about-products.page.scss'],
  imports: [RouterLink, DecimalPipe, IonHeader, IonToolbar, IonButtons, IonMenuButton, IonTitle, IonContent, IonIcon],
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

  readonly promises = [
    { icon: 'ribbon-outline', title: 'Premium ingredients', text: 'Real butter, 65% Belgian chocolate, local cashews and ube.' },
    { icon: 'time-outline', title: 'Baked fresh daily', text: 'Every order comes from that morning\'s batch. Never frozen.' },
    { icon: 'resize-outline', title: 'Jumbo 4.5" size', text: 'Thick, about 110 g each, and big enough to share (or not).' },
    { icon: 'gift-outline', title: 'Gift-ready boxes', text: 'Packed in our pink signature box with a handwritten note.' },
  ];

  constructor() {
    void this.products.load();
  }
}
