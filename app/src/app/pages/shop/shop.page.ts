/**
 * @file shop.page.ts
 * @description "All Cookies" tab: the full menu from Neon with search, categories, a filter sheet
 * (price, allergen-free, deals and tags) and sorting.
 * Query params (?category=, ?show=best|new|promo, ?focus=1) let Home deep-link into it.
 */
import { Component, computed, effect, inject, signal, viewChild } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { DecimalPipe } from '@angular/common';
import {
  IonButton,
  IonButtons,
  IonContent,
  IonFooter,
  IonHeader,
  IonIcon,
  IonMenuButton,
  IonModal,
  IonRefresher,
  IonRefresherContent,
  IonSearchbar,
  IonSelect,
  IonSelectOption,
  IonSkeletonText,
  IonTitle,
  IonToolbar,
  RefresherCustomEvent,
} from '@ionic/angular';
import { CartService } from '../../core/cart.service';
import { ProductService } from '../../core/product.service';
import { ShopActionsService } from '../../core/shop-actions.service';
import {
  CATEGORIES,
  COLLECTIONS,
  Collection,
  CookieCategory,
  Product,
  effectivePrice,
  inCollection,
} from '../../core/models';
import { ProductCardComponent } from '../../components/product-card.component';
import { OfflineMenuIndicatorComponent } from '../../components/offline-menu-indicator.component';
import { prefersReducedMotion } from '../../core/preference.service';
import { PhotoPipe } from '../../core/photo.pipe';
import { AsyncPipe } from '@angular/common';

type SortKey = 'recommended' | 'price-asc' | 'price-desc' | 'rating';
type PriceBand = 'any' | 'under-120' | '120-140' | 'over-140';

export const PRICE_BANDS: { id: PriceBand; label: string }[] = [
  { id: 'any', label: 'Any price' },
  { id: 'under-120', label: 'Under ₱120' },
  { id: '120-140', label: '₱120 to ₱140' },
  { id: 'over-140', label: 'Over ₱140' },
];

/** Allergen names exactly as the menu lists them. */
export const ALLERGEN_FILTERS = [
  { id: 'Peanuts', label: 'No peanuts' },
  { id: 'Tree Nuts', label: 'No tree nuts' },
  { id: 'Dairy', label: 'No dairy' },
  { id: 'Soy', label: 'No soy' },
  { id: 'Eggs', label: 'No eggs' },
] as const;

export const TAG_FILTERS: Collection[] = ['promo', 'new', 'best', 'halloween'];

/** True when the price the customer pays falls in the chosen band. */
export function inPriceBand(p: Product, band: PriceBand): boolean {
  const price = effectivePrice(p);
  if (band === 'under-120') return price < 120;
  if (band === '120-140') return price >= 120 && price <= 140;
  if (band === 'over-140') return price > 140;
  return true;
}

const isCategory = (v: unknown): v is CookieCategory | 'all' => CATEGORIES.some((c) => c.id === v);
const isCollection = (v: unknown): v is Collection => typeof v === 'string' && Object.hasOwn(COLLECTIONS, v);

@Component({
  selector: 'app-shop',
  templateUrl: 'shop.page.html',
  styleUrls: ['../catalog.scss', 'shop.page.scss'],
  imports: [PhotoPipe, AsyncPipe, 
    IonHeader,
    IonToolbar,
    IonButtons,
    IonMenuButton,
    IonTitle,
    IonContent,
    IonFooter,
    IonModal,
    IonRefresher,
    IonRefresherContent,
    IonSearchbar,
    IonSelect,
    IonSelectOption,
    IonSkeletonText,
    IonIcon,
    IonButton,
    RouterLink,
    DecimalPipe,
    ProductCardComponent,
    OfflineMenuIndicatorComponent,
  ],
})
export class ShopPage {
  readonly cart = inject(CartService);
  readonly products = inject(ProductService);
  private shop = inject(ShopActionsService);
  private router = inject(Router);
  private route = inject(ActivatedRoute);

  private readonly searchbar = viewChild(IonSearchbar);
  private readonly queryParams = toSignal(this.route.queryParamMap, {
    initialValue: this.route.snapshot.queryParamMap,
  });

  readonly categories = CATEGORIES;
  readonly collections = COLLECTIONS;
  readonly category = signal<CookieCategory | 'all'>('all');
  readonly collection = signal<Collection | null>(null);
  readonly search = signal('');
  readonly sort = signal<SortKey>('recommended');
  readonly skeletons = [1, 2, 3, 4, 5, 6];

  /* ---------- Filter sheet ---------- */
  readonly priceBands = PRICE_BANDS;
  readonly allergenFilters = ALLERGEN_FILTERS;
  readonly tagFilters = TAG_FILTERS;
  readonly filtersOpen = signal(false);
  readonly priceBand = signal<PriceBand>('any');
  /** Allergens the customer wants to avoid. */
  readonly freeFrom = signal<ReadonlySet<string>>(new Set());
  /** Cookies matching any selected tag are shown. */
  readonly tags = signal<ReadonlySet<Collection>>(new Set());
  readonly activeFilterCount = computed(
    () => (this.priceBand() !== 'any' ? 1 : 0) + this.freeFrom().size + this.tags().size,
  );

  readonly sortOptions: { value: SortKey; label: string }[] = [
    { value: 'recommended', label: 'Recommended' },
    { value: 'price-asc', label: 'Price: low to high' },
    { value: 'price-desc', label: 'Price: high to low' },
    { value: 'rating', label: 'Top rated' },
  ];

  readonly visible = computed(() => {
    const term = this.search().trim().toLowerCase();
    const cat = this.category();
    const col = this.collection();
    const band = this.priceBand();
    const avoid = this.freeFrom();
    const tags = this.tags();
    const list = this.products
      .products()
      .filter(
        (p) =>
          (cat === 'all' || p.category === cat) &&
          (!col || inCollection(p, col)) &&
          inPriceBand(p, band) &&
          !p.allergens.some((a) => avoid.has(a)) &&
          (!tags.size || [...tags].some((tag) => inCollection(p, tag))) &&
          (!term || `${p.name} ${p.tagline} ${p.flavorNotes}`.toLowerCase().includes(term)),
      );
    switch (this.sort()) {
      case 'price-asc':
        return [...list].sort((a, b) => effectivePrice(a) - effectivePrice(b));
      case 'price-desc':
        return [...list].sort((a, b) => effectivePrice(b) - effectivePrice(a));
      case 'rating':
        return [...list].sort((a, b) => b.rating - a.rating || b.reviewsCount - a.reviewsCount);
      default:
        return list;
    }
  });

  /** How many cookies each category chip holds. */
  readonly categoryCounts = computed(() => {
    const counts = new Map<string, number>([['all', this.products.products().length]]);
    for (const p of this.products.products()) counts.set(p.category, (counts.get(p.category) ?? 0) + 1);
    return counts;
  });

  /* ---------- Cookie roulette: "Can't decide? Spin!" ---------- */
  readonly rouletteFace = signal<Product | null>(null);
  readonly rouletteResult = signal<Product | null>(null);
  readonly spinning = signal(false);
  /** Bumped on every win so the sprinkle burst replays. */
  readonly burst = signal(0);
  readonly sprinkles = Array.from({ length: 14 }, (_, i) => ({
    angle: (360 / 14) * i,
    color: ['#f472b6', '#523628', '#f5a524', '#be185d', '#fbcfe8'][i % 5],
  }));
  readonly price = effectivePrice;

  /** Flicks through the cookies on screen like a slot machine, slowing down until one lands. */
  spin(): void {
    const pool = this.visible().length ? this.visible() : this.products.products();
    if (this.spinning() || !pool.length) return;
    if (prefersReducedMotion()) {
      const next = pool[Math.floor(Math.random() * pool.length)];
      this.rouletteFace.set(next);
      this.rouletteResult.set(next);
      this.burst.update((n) => n + 1);
      return;
    }
    this.spinning.set(true);
    this.rouletteResult.set(null);
    const steps = 16;
    let step = 0;
    const tick = () => {
      let next = pool[Math.floor(Math.random() * pool.length)];
      if (pool.length > 1 && next === this.rouletteFace()) next = pool[(pool.indexOf(next) + 1) % pool.length];
      this.rouletteFace.set(next);
      step++;
      if (step < steps) {
        setTimeout(tick, 45 + step * step * 1.4); // each flick a little slower, like a wheel
      } else {
        this.spinning.set(false);
        this.rouletteResult.set(next);
        this.burst.update((n) => n + 1);
      }
    };
    tick();
  }

  readonly hasFilters = computed(
    () => this.category() !== 'all' || !!this.collection() || !!this.search().trim() || this.activeFilterCount() > 0,
  );

  constructor() {
    void this.products.load();

    // Follow deep links from Home (the tab stays alive, so react to every change).
    effect(() => {
      const params = this.queryParams();
      const cat = params.get('category');
      const col = params.get('show');
      this.category.set(isCategory(cat) ? cat : 'all');
      this.collection.set(isCollection(col) ? col : null);
    });
    effect(() => {
      if (this.queryParams().get('focus') === '1') setTimeout(() => void this.searchbar()?.setFocus(), 450);
    });
  }

  onSearch(value: string | null | undefined): void {
    this.search.set(value ?? '');
  }

  pickCategory(id: CookieCategory | 'all'): void {
    this.category.set(id);
  }

  setSort(value: unknown): void {
    if (this.sortOptions.some((o) => o.value === value)) this.sort.set(value as SortKey);
  }

  clearCollection(): void {
    this.collection.set(null);
    void this.router.navigate([], { queryParams: { show: null }, queryParamsHandling: 'merge', replaceUrl: true });
  }

  setPriceBand(band: PriceBand): void {
    this.priceBand.set(band);
  }

  toggleFreeFrom(allergen: string): void {
    this.freeFrom.update((set) => toggled(set, allergen));
  }

  toggleTag(tag: Collection): void {
    this.tags.update((set) => toggled(set, tag));
  }

  clearSheetFilters(): void {
    this.priceBand.set('any');
    this.freeFrom.set(new Set());
    this.tags.set(new Set());
  }

  resetFilters(): void {
    this.search.set('');
    this.category.set('all');
    this.collection.set(null);
    this.clearSheetFilters();
    void this.router.navigate(['/shop'], { replaceUrl: true });
  }

  async refresh(event: RefresherCustomEvent): Promise<void> {
    await this.products.load(true);
    await event.target.complete();
  }

  retry(): void {
    void this.products.load(true);
  }

  addToCart(product: Product): void {
    void this.shop.choosePack(product);
  }
}

function toggled<T>(set: ReadonlySet<T>, value: T): ReadonlySet<T> {
  const next = new Set(set);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}
