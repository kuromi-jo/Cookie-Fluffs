/**
 * @file box-builder.service.ts
 * @description The box being built right now. Lives in a service (not the page) so it
 * survives navigation, e.g. logging in halfway through.
 */
import { Injectable, computed, signal } from '@angular/core';
import { BoxSize, Product, boxPrice, packOption } from './models';

@Injectable({ providedIn: 'root' })
export class BoxBuilderService {
  readonly size = signal<BoxSize>(6);
  /** One entry per slot; null = empty spot. */
  readonly slots = signal<(Product | null)[]>(Array(6).fill(null));

  readonly filled = computed(() => this.slots().filter((s): s is Product => s !== null));
  readonly count = computed(() => this.filled().length);
  readonly remaining = computed(() => this.size() - this.count());
  readonly isFull = computed(() => this.remaining() === 0);
  readonly option = computed(() => packOption(this.size())!);
  readonly price = computed(() => boxPrice(this.filled(), this.size()));

  /** Starts a fresh box, optionally with a first cookie already in it. */
  start(size: BoxSize, first?: Product): void {
    this.size.set(size);
    this.slots.set(Array(size).fill(null));
    if (first) this.add(first);
  }

  /** Changes the box size, keeping as many cookies as fit. */
  resize(size: BoxSize): void {
    const kept = this.filled().slice(0, size);
    this.size.set(size);
    this.slots.set([...kept, ...Array(size - kept.length).fill(null)]);
  }

  /** Drops a cookie into the first empty spot. Returns false when the box is already full. */
  add(product: Product): boolean {
    const slots = [...this.slots()];
    const i = slots.indexOf(null);
    if (i === -1) return false;
    slots[i] = product;
    this.slots.set(slots);
    return true;
  }

  removeAt(index: number): void {
    const slots = [...this.slots()];
    slots[index] = null;
    this.slots.set(slots);
  }

  clear(): void {
    this.slots.set(Array(this.size()).fill(null));
  }

  /** "Surprise me": fills every empty spot with a random cookie. */
  surprise(menu: Product[]): void {
    if (!menu.length) return;
    const slots = this.slots().map((s) => s ?? menu[Math.floor(Math.random() * menu.length)]);
    this.slots.set(slots);
  }

  /** Product ids in slot order, ready for the API. */
  productIds(): number[] {
    return this.filled().map((p) => p.id);
  }
}
