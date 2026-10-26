/**
 * @file cart.service.ts
 * @description The logged-in user's cart. Every change is saved to Neon through the API,
 * and the server answers with the updated cart and totals.
 * The cart holds single cookies and mix-and-match boxes (4, 6 or 12).
 */
import { Injectable, WritableSignal, computed, effect, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, firstValueFrom } from 'rxjs';
import { environment } from '../../environments/environment';
import { AuthService } from './auth.service';
import { BoxSize, Cart, EMPTY_CART } from './models';

@Injectable({ providedIn: 'root' })
export class CartService {
  private http = inject(HttpClient);
  private auth = inject(AuthService);
  private base = `${environment.apiUrl}/cart`;

  readonly cart = signal<Cart>(EMPTY_CART);
  readonly loading = signal(false);
  /** Product ids with a request in progress, so buttons can show a spinner. */
  readonly busy = signal<ReadonlySet<number>>(new Set());
  /** Box ids with a request in progress. */
  readonly boxBusy = signal<ReadonlySet<number>>(new Set());

  readonly count = computed(() => this.cart().itemCount);

  constructor() {
    // Load the cart whenever someone logs in; clear it when they log out.
    effect(() => {
      if (this.auth.isLoggedIn()) {
        void this.load().catch(() => undefined);
      } else {
        this.cart.set(EMPTY_CART);
      }
    });
  }

  /** How many of this cookie are in the cart, counting singles and cookies inside boxes. */
  quantityOf(productId: number): number {
    const cart = this.cart();
    const singles = cart.items.find((i) => i.productId === productId)?.quantity ?? 0;
    const inBoxes = cart.boxes.reduce(
      (sum, b) => sum + b.cookies.filter((c) => c.productId === productId).length * b.quantity,
      0,
    );
    return singles + inBoxes;
  }

  async load(): Promise<void> {
    this.loading.set(true);
    try {
      this.cart.set(await firstValueFrom(this.http.get<Cart>(this.base)));
    } finally {
      this.loading.set(false);
    }
  }

  add(productId: number, quantity = 1): Promise<Cart> {
    return this.run(productId, this.http.post<Cart>(this.base, { productId, quantity }));
  }

  setQuantity(productId: number, quantity: number): Promise<Cart> {
    return this.run(productId, this.http.patch<Cart>(`${this.base}/${productId}`, { quantity }));
  }

  /** Ticks or unticks one item (saved to Neon so the choice survives a refresh). */
  setSelected(productId: number, selected: boolean): Promise<Cart> {
    return this.run(productId, this.http.patch<Cart>(`${this.base}/${productId}`, { selected }));
  }

  /** "Select all" checkbox. */
  async selectAll(selected: boolean): Promise<void> {
    this.cart.set(await firstValueFrom(this.http.patch<Cart>(this.base, { selected })));
  }

  remove(productId: number): Promise<Cart> {
    return this.run(productId, this.http.delete<Cart>(`${this.base}/${productId}`));
  }

  /** Adds a finished box. productIds holds one cookie per slot. */
  async addBox(size: BoxSize, productIds: number[]): Promise<Cart> {
    const cart = await firstValueFrom(this.http.post<Cart>(`${this.base}/boxes`, { size, productIds }));
    this.cart.set(cart);
    return cart;
  }

  setBoxQuantity(boxId: number, quantity: number): Promise<Cart> {
    return this.runBox(boxId, this.http.patch<Cart>(`${this.base}/boxes/${boxId}`, { quantity }));
  }

  setBoxSelected(boxId: number, selected: boolean): Promise<Cart> {
    return this.runBox(boxId, this.http.patch<Cart>(`${this.base}/boxes/${boxId}`, { selected }));
  }

  removeBox(boxId: number): Promise<Cart> {
    return this.runBox(boxId, this.http.delete<Cart>(`${this.base}/boxes/${boxId}`));
  }

  async clear(): Promise<void> {
    this.cart.set(await firstValueFrom(this.http.delete<Cart>(this.base)));
  }

  /** Applies an authoritative cart returned by another server-side cart workflow. */
  replaceFromServer(cart: Cart): void {
    this.cart.set(cart);
  }

  private run(productId: number, request: Observable<Cart>): Promise<Cart> {
    return this.track(this.busy, productId, request);
  }

  private runBox(boxId: number, request: Observable<Cart>): Promise<Cart> {
    return this.track(this.boxBusy, boxId, request);
  }

  /** Marks an id as busy while the request runs, then stores the cart the server sends back. */
  private async track(
    set: WritableSignal<ReadonlySet<number>>,
    id: number,
    request: Observable<Cart>,
  ): Promise<Cart> {
    set.update((s) => new Set(s).add(id));
    try {
      const cart = await firstValueFrom(request);
      this.cart.set(cart);
      return cart;
    } finally {
      set.update((s) => {
        const next = new Set(s);
        next.delete(id);
        return next;
      });
    }
  }
}
