/**
 * @file admin.service.ts
 * @description Superadmin dashboard data: sales overview, orders, products and the activity feed.
 * All numbers come from the server (/api/admin); this service only loads and stores them.
 */
import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { environment } from '../../environments/environment';

export type AdminOrderStatus = 'placed' | 'confirmed' | 'preparing' | 'ready' | 'out_for_delivery' | 'completed' | 'cancelled';
/** Orders tab filters: a status, everything, or orders waiting on a cancellation decision. */
export type AdminOrderFilter = AdminOrderStatus | 'all' | 'cancel_requests';

export interface AdminSummary {
  todaySales: number;
  totalSales: number;
  todayOrders: number;
  totalOrders: number;
  activeOrders: number;
  /** Orders still waiting to be confirmed. */
  newOrders: number;
  pendingCancellations: number;
  bestSellers: { id: number; name: string; imageUrl: string; sold: number }[];
}

export interface AdminOrder {
  id: string;
  status: AdminOrderStatus;
  paymentStatus: string;
  fulfillment: 'delivery' | 'pickup';
  customerName: string;
  phone: string;
  address: string;
  notes: string;
  total: number;
  createdAt: string;
  items: string | null;
  cancellationRequestId: string | null;
  nextStatus: AdminOrderStatus | null;
}

export interface AdminProduct {
  id: number;
  name: string;
  category: string;
  imageUrl: string;
  price: number;
  salePrice: number | null;
  isAvailable: boolean;
}

/** Choices for new products; must match PRODUCT_* lists in server/src/routes/admin.js. */
export const PRODUCT_CATEGORY_OPTIONS = [
  { id: 'classic', label: 'Classic' },
  { id: 'indulgent', label: 'Indulgent' },
  { id: 'fruity', label: 'Fruity' },
  { id: 'nutty', label: 'Nutty' },
  { id: 'dietary', label: 'Lighter' },
] as const;
export const PRODUCT_SEASON_OPTIONS = [
  { id: '', label: 'Regular menu' },
  { id: 'halloween', label: 'Halloween' },
] as const;
export const PRODUCT_ALLERGEN_OPTIONS = ['Gluten', 'Dairy', 'Eggs', 'Peanuts', 'Tree Nuts', 'Soy'] as const;
/** Badge dropdown choices; a promo price replaces the badge with an automatic "N% off". Mirrors PRODUCT_BADGES on the server. */
export const PRODUCT_BADGE_OPTIONS = ['New', 'Halloween'] as const;

export interface NewProductInput {
  name: string;
  tagline: string;
  description: string;
  flavorNotes: string;
  category: string;
  season: string | null;
  price: number;
  salePrice: number | null;
  calories: number;
  allergens: string[];
  badge: string | null;
  isBestSeller: boolean;
  isNew: boolean;
  isAvailable: boolean;
  image: string;
}

export interface AdminFeedItem {
  kind: 'order' | 'cancellation' | 'review' | 'message';
  orderId: string;
  at: string;
  title: string;
  body: string;
  unread: boolean;
  /** Set for review items: open that cookie's page with the review highlighted. */
  productId: number | null;
  reviewId: string | null;
  /** Set for Contact Us messages. */
  message: { id: number; name: string; email: string; subject: string; message: string } | null;
}

export interface AdminReview {
  id: string;
  rating: number;
  comment: string | null;
  anonymous: boolean;
  createdAt: string;
  productId: number;
  productName: string;
  imageUrl: string;
  customerName: string;
  orderId: string;
}

export interface AdminReviews {
  average: number;
  count: number;
  reviews: AdminReview[];
}

export type AdminTab = 'overview' | 'orders' | 'products' | 'reviews' | 'messages';

/** A Contact Us message (read only). */
export interface AdminMessage {
  id: number;
  name: string;
  email: string;
  topic: string;
  message: string;
  createdAt: string;
  /** Sent while logged in to a Cookie Fluffs account (otherwise as a guest). */
  fromAccount: boolean;
  accountPhone: string | null;
}

export interface AdminMessageList {
  total: number;
  topics: string[];
  messages: AdminMessage[];
}

export interface AdminMessageQuery {
  q?: string;
  topic?: string;
  from?: 'accounts' | 'guests' | '';
}

const SHOP_VIEW_KEY = 'cf.adminShopView';
const SEEN_KEY = 'cf.adminSeen';

/** Per-section "last seen" marks for the admin menu badges (kept on this device). */
interface SeenState {
  orders?: string;
  reviews?: string;
  messages?: string;
  products?: number;
}

function readSeen(): SeenState {
  try {
    const value = JSON.parse(localStorage.getItem(SEEN_KEY) ?? '{}');
    return value && typeof value === 'object' ? value : {};
  } catch {
    return {};
  }
}

function writeSeen(seen: SeenState): void {
  try {
    localStorage.setItem(SEEN_KEY, JSON.stringify(seen));
  } catch {
    // storage blocked: badges still work for this session
  }
}

/** True while the admin is browsing the customer app ("View the shop") instead of the dashboard. */
export function adminShopView(): boolean {
  try {
    return sessionStorage.getItem(SHOP_VIEW_KEY) === '1';
  } catch {
    return false;
  }
}

export function setAdminShopView(on: boolean): void {
  try {
    if (on) sessionStorage.setItem(SHOP_VIEW_KEY, '1');
    else sessionStorage.removeItem(SHOP_VIEW_KEY);
  } catch {
    // storage blocked: the admin simply lands on the dashboard
  }
}

@Injectable({ providedIn: 'root' })
export class AdminService {
  private http = inject(HttpClient);
  private base = `${environment.apiUrl}/admin`;

  /** Dashboard section, shared with the admin side menu. */
  readonly tab = signal<AdminTab>('overview');
  readonly reviews = signal<AdminReviews | null>(null);

  async loadMessages(filter: AdminMessageQuery = {}): Promise<void> {
    const params: Record<string, string> = {};
    if (filter.q?.trim()) params['q'] = filter.q.trim();
    if (filter.topic) params['topic'] = filter.topic;
    if (filter.from) params['from'] = filter.from;
    this.messages.set(await firstValueFrom(this.http.get<AdminMessageList>(`${this.base}/messages`, { params })));
  }

  async loadReviews(): Promise<void> {
    this.reviews.set(await firstValueFrom(this.http.get<AdminReviews>(`${this.base}/reviews`)));
  }

  readonly summary = signal<AdminSummary | null>(null);
  readonly orders = signal<AdminOrder[]>([]);
  readonly products = signal<AdminProduct[]>([]);
  readonly feed = signal<AdminFeedItem[]>([]);
  readonly unread = signal(0);

  /** Number badges for the admin side menu: what needs attention in each section. */
  /** What the admin has already seen per section (newest order/review time, highest product id). */
  private readonly seen = signal<SeenState>(readSeen());
  private feedLoaded = false;

  /**
   * Number badges for the admin side menu: items that arrived since that section was last opened.
   * Opening the section clears its badge; while it stays open, new arrivals are marked seen too.
   */
  readonly badges = computed<Record<AdminTab, number>>(() => {
    const seen = this.seen();
    const newer = (kinds: AdminFeedItem['kind'][], since?: string) =>
      since ? this.feed().filter((i) => kinds.includes(i.kind) && Date.parse(i.at) > Date.parse(since)).length : 0;
    return {
      overview: 0,
      orders: newer(['order', 'cancellation'], seen.orders),
      products: seen.products === undefined ? 0 : this.products().filter((p) => p.id > seen.products!).length,
      reviews: newer(['review'], seen.reviews),
      messages: newer(['message'], seen.messages),
    };
  });
  readonly anyBadge = computed(() => Object.values(this.badges()).some((n) => n > 0));

  constructor() {
    effect(() => {
      const tab = this.tab();
      const feed = this.feed();
      const products = this.products();
      untracked(() => {
        const seen = { ...this.seen() };
        const latest = (kinds: AdminFeedItem['kind'][]) =>
          feed.filter((i) => kinds.includes(i.kind)).reduce<string | undefined>((max, i) => (!max || Date.parse(i.at) > Date.parse(max) ? i.at : max), undefined);
        const maxProduct = products.reduce((max, p) => Math.max(max, p.id), 0) || undefined;
        // First run: start from what exists now, so old items are not flagged as new.
        if (this.feedLoaded) {
          if (!seen.orders || tab === 'orders') seen.orders = latest(['order', 'cancellation']) ?? seen.orders ?? new Date(0).toISOString();
          if (!seen.reviews || tab === 'reviews') seen.reviews = latest(['review']) ?? seen.reviews ?? new Date(0).toISOString();
          if (!seen.messages || tab === 'messages') seen.messages = latest(['message']) ?? seen.messages ?? new Date(0).toISOString();
        }
        if (maxProduct && (seen.products === undefined || tab === 'products')) seen.products = Math.max(seen.products ?? 0, maxProduct);
        const before = this.seen();
        if (seen.orders !== before.orders || seen.reviews !== before.reviews || seen.messages !== before.messages
          || seen.products !== before.products) {
          this.seen.set(seen);
          writeSeen(seen);
        }
      });
    });
  }

  async loadSummary(): Promise<void> {
    this.summary.set(await firstValueFrom(this.http.get<AdminSummary>(`${this.base}/summary`)));
  }

  /** Text typed in the Orders search (customer name, phone, address, order number or cookie). */
  readonly orderSearch = signal('');
  readonly messages = signal<AdminMessageList | null>(null);

  async loadOrders(status: AdminOrderFilter): Promise<void> {
    const params: Record<string, string> = status === 'all' ? {} : { status };
    const q = this.orderSearch().trim();
    if (q) params['q'] = q;
    this.orders.set(await firstValueFrom(this.http.get<AdminOrder[]>(`${this.base}/orders`, { params })));
  }

  async loadProducts(): Promise<void> {
    this.products.set(await firstValueFrom(this.http.get<AdminProduct[]>(`${this.base}/products`)));
  }

  async loadFeed(): Promise<AdminFeedItem[]> {
    const res = await firstValueFrom(this.http.get<{ items: AdminFeedItem[]; unread: number }>(`${this.base}/feed`));
    this.feedLoaded = true;
    this.feed.set(res.items);
    this.unread.set(res.unread);
    return res.items;
  }

  async markFeedSeen(): Promise<void> {
    await firstValueFrom(this.http.post(`${this.base}/feed/seen`, {}));
    this.unread.set(0);
    this.feed.update((items) => items.map((i) => ({ ...i, unread: false })));
  }

  advance(orderId: string, status: AdminOrderStatus): Promise<unknown> {
    return firstValueFrom(this.http.post(`${this.base}/orders/${orderId}/advance`, { status }));
  }

  resolveCancellation(requestId: string, decision: 'approve' | 'decline'): Promise<unknown> {
    return firstValueFrom(this.http.post(`${this.base}/cancellations/${requestId}`, { decision }));
  }

  /** Adds a brand-new cookie (image is a data URL). Returns the created product and refreshes the list. */
  async createProduct(input: NewProductInput): Promise<AdminProduct> {
    const created = await firstValueFrom(this.http.post<AdminProduct>(`${this.base}/products`, input));
    await this.loadProducts();
    return created;
  }

  async updateProduct(id: number, changes: Partial<Pick<AdminProduct, 'price' | 'salePrice' | 'isAvailable'>>): Promise<AdminProduct> {
    const updated = await firstValueFrom(this.http.patch<AdminProduct>(`${this.base}/products/${id}`, changes));
    this.products.update((list) => list.map((p) => (p.id === id ? updated : p)));
    return updated;
  }
}
