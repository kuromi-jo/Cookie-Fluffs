/**
 * @file admin.page.ts
 * @description Superadmin dashboard: Overview (sales, orders, best sellers), Orders (move them through
 * fulfillment, answer cancellation requests) and Products (price, promo, availability).
 * Everything refreshes live when shop data changes; a bell lists new orders and cancellation requests.
 */
import { Component, ElementRef, computed, effect, inject, signal, untracked, viewChild } from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import {
  AlertController,
  ModalController,
  IonButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonIcon,
  IonRefresher,
  IonRefresherContent,
  IonSegment,
  IonSearchbar,
  IonSegmentButton,
  IonSpinner,
  IonToggle,
  IonMenuButton,
  IonToolbar,
  NavController,
  RefresherCustomEvent,
} from '@ionic/angular';
import { AuthService } from '../../core/auth.service';
import { AdminFeedItem, AdminOrder, AdminOrderFilter, AdminOrderStatus, AdminProduct, AdminService, setAdminShopView } from '../../core/admin.service';
import { LiveService } from '../../core/live.service';
import { UiService } from '../../core/ui.service';
import { apiErrorMessage } from '../../core/api-error';
import { AdminProductFormComponent } from '../../components/admin-product-form.modal';
import { AdminFeedComponent } from '../../components/admin-feed.modal';
import { AdminReviewsComponent } from '../../components/admin-reviews.component';
import { AdminMessagesComponent } from '../../components/admin-messages.component';
import { PhotoPipe } from '../../core/photo.pipe';
import { AsyncPipe } from '@angular/common';


const STATUS_LABEL: Record<AdminOrderStatus, string> = {
  placed: 'New',
  confirmed: 'Confirmed',
  preparing: 'Preparing',
  ready: 'Ready',
  out_for_delivery: 'Out for delivery',
  completed: 'Completed',
  cancelled: 'Cancelled',
};

const ACTION_LABEL: Partial<Record<AdminOrderStatus, string>> = {
  confirmed: 'Confirm order',
  preparing: 'Start preparing',
  ready: 'Mark as ready',
  out_for_delivery: 'Send out for delivery',
  completed: 'Mark as completed',
};

interface ProductDraft {
  price: string;
  salePrice: string;
}

@Component({
  selector: 'app-admin',
  host: { '(window:resize)': 'updateSegMore()' },
  templateUrl: 'admin.page.html',
  styleUrls: ['admin.page.scss'],
  imports: [PhotoPipe, AsyncPipe, 
    DatePipe,
    DecimalPipe,
    FormsModule,
    IonHeader,
    IonToolbar,
    IonButtons,
    IonButton,
    IonIcon,
    IonContent,
    IonRefresher,
    IonRefresherContent,
    IonSegment,
    IonSearchbar,
    IonSegmentButton,
    IonSpinner,
    IonToggle,
    IonMenuButton,
    AdminReviewsComponent,
    AdminMessagesComponent,
  ],
})
export class AdminPage {
  readonly admin = inject(AdminService);
  private auth = inject(AuthService);
  private live = inject(LiveService);
  private ui = inject(UiService);
  private alerts = inject(AlertController);
  private nav = inject(NavController);
  private modals = inject(ModalController);

  readonly tab = this.admin.tab;
  readonly statusFilter = signal<AdminOrderFilter>('all');
  readonly loading = signal(true);
  readonly error = signal('');
  readonly busy = signal<ReadonlySet<string>>(new Set());
  readonly drafts = signal<Record<number, ProductDraft>>({});
  /* ---------------------------------------------------------------- section tabs (swipe) */

  private readonly segment = viewChild('segment', { read: ElementRef });
  /** Whether more tabs are hidden off the left / right edge (shows the chevron tokens). */
  readonly segMore = signal({ left: false, right: false });

  /** Keeps the tokens in sync with the swipe position, and the chosen tab in view. */
  private readonly segWatch = effect(() => {
    const el = this.segment()?.nativeElement as HTMLElement | undefined;
    const tab = this.tab();
    if (!el) return;
    untracked(() => setTimeout(() => {
      el.querySelector<HTMLElement>(`ion-segment-button[value="${tab}"]`)?.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' });
      this.updateSegMore();
    }, 60));
  });

  updateSegMore(): void {
    const el = this.segment()?.nativeElement as HTMLElement | undefined;
    if (!el) return;
    const left = el.scrollLeft > 4;
    const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 4;
    const now = this.segMore();
    if (now.left !== left || now.right !== right) this.segMore.set({ left, right });
  }

  nudgeTabs(direction: 1 | -1): void {
    const el = this.segment()?.nativeElement as HTMLElement | undefined;
    el?.scrollBy({ left: direction * el.clientWidth * 0.6, behavior: 'smooth' });
  }

  /** Products tab search (name or category), filtered on this device. */
  readonly productSearch = signal('');
  readonly shownProducts = computed(() => {
    const q = this.productSearch().trim().toLowerCase();
    if (!q) return this.admin.products();
    return this.admin.products().filter((p) => p.name.toLowerCase().includes(q) || p.category.toLowerCase().includes(q));
  });

  readonly statusLabel = STATUS_LABEL;
  readonly actionLabel = ACTION_LABEL;
  readonly filters: AdminOrderFilter[] = ['all', 'cancel_requests', 'placed', 'confirmed', 'preparing', 'ready', 'out_for_delivery', 'completed', 'cancelled'];

  private newestFeedAt = '';

  /** Live: whenever shop data changes, reload what is on screen without a spinner. */
  private readonly liveRefresh = effect(() => {
    if (!this.live.adminTick()) return;
    untracked(() => void this.refresh(false));
  });

  constructor() {
    setAdminShopView(false); // back on the dashboard: Home sends the admin here again
    void this.refresh(true);
  }

  async refresh(showSpinner: boolean): Promise<void> {
    if (showSpinner) this.loading.set(true);
    try {
      await Promise.all([
        this.admin.loadSummary(),
        this.admin.loadOrders(this.statusFilter()),
        this.tab() === 'products' || !this.admin.products().length ? this.admin.loadProducts() : Promise.resolve(),
        this.tab() === 'reviews' || !this.admin.reviews() ? this.admin.loadReviews() : Promise.resolve(),
        this.loadFeedAndAnnounce(),
      ]);
      this.error.set('');
    } catch (err) {
      if (showSpinner || !this.admin.summary()) this.error.set(apiErrorMessage(err));
    } finally {
      this.loading.set(false);
    }
  }

  async pullToRefresh(event: RefresherCustomEvent): Promise<void> {
    await this.refresh(false);
    await event.target.complete();
  }

  /** Shows a toast for feed items that arrived since the last check (new orders, cancellation requests). */
  private async loadFeedAndAnnounce(): Promise<void> {
    const items = await this.admin.loadFeed();
    const fresh = this.newestFeedAt ? items.filter((i) => i.at > this.newestFeedAt) : [];
    if (items[0]) this.newestFeedAt = items[0].at;
    if (fresh.length) {
      void this.ui.toast(fresh.length === 1 ? fresh[0].title : `${fresh.length} new updates`, {
        icon: ({ order: 'receipt-outline', review: 'star-outline', message: 'mail-outline', cancellation: 'alert-circle-outline' } as const)[fresh[0].kind],
        buttons: [{ text: 'View', handler: () => this.openFeedItem(fresh[0]) }],
      });
    }
  }

  setTab(value: unknown): void {
    if (value === 'overview' || value === 'orders' || value === 'products' || value === 'reviews' || value === 'messages') {
      this.tab.set(value);
      if (value === 'products' && !this.admin.products().length) void this.admin.loadProducts().catch(() => undefined);
      if (value === 'reviews') void this.admin.loadReviews().catch(() => undefined);
    }
  }

  /** Orders search runs on the server (name, phone, address, order number or any cookie in the order). */
  async searchOrders(value: string | null | undefined): Promise<void> {
    this.admin.orderSearch.set(value ?? '');
    try {
      await this.admin.loadOrders(this.statusFilter());
    } catch (err) {
      void this.ui.toast(apiErrorMessage(err), { error: true });
    }
  }

  async setFilter(status: AdminOrderFilter): Promise<void> {
    this.statusFilter.set(status);
    try {
      await this.admin.loadOrders(status);
    } catch (err) {
      void this.ui.toast(apiErrorMessage(err), { error: true });
    }
  }

  /* ---------------------------------------------------------------- feed */

  /** Notifications slide up as a full-screen sheet; the dashboard (tab, filter, scroll) stays put underneath. */
  async openFeed(): Promise<void> {
    const sheet = await this.modals.create({ component: AdminFeedComponent, cssClass: 'cf-notif-sheet' });
    await sheet.present();
    const { data, role } = await sheet.onDidDismiss<AdminFeedItem | null>();
    // Mark seen after closing, so the new items keep their highlight while the sheet is open.
    if (this.admin.unread()) void this.admin.markFeedSeen().catch(() => undefined);
    if (role === 'open' && data) this.openFeedItem(data);
  }

  /** Opens what a notification is about: the order, the reviewed cookie, or the customer's message. */
  openFeedItem(item: AdminFeedItem): void {
    if (item.kind === 'message' && item.message) void this.openMessage(item.message);
    else if (item.kind === 'review' && item.productId && item.reviewId) this.openReview(item.productId, item.reviewId);
    else this.openOrderFromFeed(item);
  }

  /** Shows a Contact Us message in full; "Reply by email" opens the admin's mail app addressed to the customer. */
  async openMessage(m: NonNullable<AdminFeedItem['message']>): Promise<void> {
    const alert = await this.alerts.create({
      header: m.subject,
      subHeader: `${m.name} · ${m.email}`,
      message: m.message,
      cssClass: 'cf-alert-confirm',
      buttons: [
        {
          text: 'Reply by email',
          cssClass: 'alert-btn-primary',
          handler: () => {
            window.location.href = `mailto:${encodeURIComponent(m.email)}?subject=${encodeURIComponent('Re: ' + m.subject)}`;
          },
        },
        { text: 'Close', role: 'cancel', cssClass: 'alert-btn-quiet' },
      ],
    });
    await alert.present();
  }

  /** Opens the cookie's page (as customers see it) scrolled to this review, highlighted. */
  openReview(productId: number, reviewId: string): void {
    void this.nav.navigateForward(['/product', productId], { queryParams: { review: reviewId } });
  }

  stars(rating: number): string[] {
    return [1, 2, 3, 4, 5].map((n) => (n <= rating ? 'star' : 'star-outline'));
  }

  openOrderFromFeed(item: AdminFeedItem): void {
    this.tab.set('orders');
    void this.setFilter('all');
    setTimeout(() => document.getElementById(`order-${item.orderId}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 300);
  }

  /* ---------------------------------------------------------------- orders */

  private async withBusy(key: string, task: () => Promise<unknown>, success: string): Promise<void> {
    this.busy.update((s) => new Set(s).add(key));
    try {
      await task();
      void this.ui.toast(success);
      await this.refresh(false);
    } catch (err) {
      void this.ui.toast(apiErrorMessage(err), { error: true });
    } finally {
      this.busy.update((s) => {
        const next = new Set(s);
        next.delete(key);
        return next;
      });
    }
  }

  advance(order: AdminOrder): void {
    if (!order.nextStatus) return;
    const next = order.nextStatus;
    void this.withBusy(order.id, () => this.admin.advance(order.id, next), `Order moved to ${STATUS_LABEL[next].toLowerCase()}`);
  }

  async decideCancellation(order: AdminOrder, decision: 'approve' | 'decline'): Promise<void> {
    if (!order.cancellationRequestId) return;
    const requestId = order.cancellationRequestId;
    const run = () =>
      this.withBusy(
        order.id,
        () => this.admin.resolveCancellation(requestId, decision),
        decision === 'approve' ? 'Order cancelled' : 'Cancellation declined; the order continues',
      );
    if (decision === 'decline') return run();
    const alert = await this.alerts.create({
      header: 'Cancel this order?',
      message: `${order.customerName}'s order will be cancelled and they will be notified.`,
      cssClass: 'cf-alert-confirm',
      buttons: [
        { text: 'Cancel the order', role: 'destructive', cssClass: 'alert-btn-quiet', handler: () => void run() },
        { text: 'Keep the order', role: 'cancel', cssClass: 'alert-btn-primary' },
      ],
    });
    await alert.present();
  }

  shortId(id: string): string {
    return id.slice(0, 8).toUpperCase();
  }

  /* ---------------------------------------------------------------- products */

  draft(p: AdminProduct): ProductDraft {
    return this.drafts()[p.id] ?? { price: String(p.price), salePrice: p.salePrice === null ? '' : String(p.salePrice) };
  }

  editDraft(p: AdminProduct, field: keyof ProductDraft, value: string | null | undefined): void {
    this.drafts.update((d) => ({ ...d, [p.id]: { ...this.draft(p), [field]: value ?? '' } }));
  }

  isDirty(p: AdminProduct): boolean {
    const d = this.drafts()[p.id];
    if (!d) return false;
    return Number(d.price) !== p.price || (d.salePrice.trim() === '' ? null : Number(d.salePrice)) !== p.salePrice;
  }

  saveProduct(p: AdminProduct): void {
    const d = this.draft(p);
    const salePrice = d.salePrice.trim() === '' ? null : Number(d.salePrice);
    void this.withBusy(
      `p${p.id}`,
      async () => {
        await this.admin.updateProduct(p.id, { price: Number(d.price), salePrice });
        this.drafts.update((all) => {
          const next = { ...all };
          delete next[p.id];
          return next;
        });
      },
      `${p.name} updated`,
    );
  }

  toggleAvailable(p: AdminProduct, isAvailable: boolean): void {
    void this.withBusy(`p${p.id}`, () => this.admin.updateProduct(p.id, { isAvailable }), `${p.name} is now ${isAvailable ? 'on' : 'off'} the menu`);
  }

  isBusy(key: string): boolean {
    return this.busy().has(key);
  }

  async openAddProduct(): Promise<void> {
    const sheet = await this.modals.create({ component: AdminProductFormComponent, cssClass: 'cf-sheet' });
    await sheet.present();
  }

  /* ---------------------------------------------------------------- account */

  async logout(): Promise<void> {
    this.auth.logout();
    await this.nav.navigateRoot('/login');
  }
}
