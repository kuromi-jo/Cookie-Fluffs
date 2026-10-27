/**
 * @file rail.component.ts
 * @description Horizontal cookie row. Touch swipes natively; on a laptop the row can be dragged
 * with the mouse or moved with the arrow buttons. The arrows are hidden on touch-only screens.
 */
import { Component, ElementRef, afterNextRender, input, signal, viewChild } from '@angular/core';
import { IonIcon } from '@ionic/angular';

@Component({
  selector: 'app-rail',
  imports: [IonIcon],
  template: `
    <div
      #track
      class="track"
      [class.dragging]="dragging()"
      [style.--inset.px]="inset()"
      (scroll)="updateEnds()"
      (pointerdown)="startDrag($event)"
      (pointermove)="drag($event)"
      (pointerup)="endDrag($event)"
      (pointercancel)="endDrag($event)"
      (dragstart)="$event.preventDefault()"
    >
      <ng-content />
    </div>
    <button type="button" class="nav prev" [style.--inset.px]="inset()" [disabled]="atStart()" [attr.aria-label]="'Scroll ' + label() + ' left'" (click)="step(-1)">
      <ion-icon name="chevron-back" aria-hidden="true"></ion-icon>
    </button>
    <button type="button" class="nav next" [style.--inset.px]="inset()" [disabled]="atEnd()" [attr.aria-label]="'Scroll ' + label() + ' right'" (click)="step(1)">
      <ion-icon name="chevron-forward" aria-hidden="true"></ion-icon>
    </button>
  `,
  styles: `
    :host { position: relative; display: block; }
    .track {
      display: flex; gap: 12px;
      margin: 0 calc(var(--inset) * -1); padding: 2px var(--inset) 8px;
      overflow-x: auto; scroll-snap-type: x mandatory; scroll-padding-inline: var(--inset);
      scrollbar-width: none; cursor: grab; touch-action: pan-x pan-y;
    }
    .track::-webkit-scrollbar { display: none; }
    .track.dragging { cursor: grabbing; scroll-snap-type: none; user-select: none; }
    .track ::ng-deep > * { flex: none; width: 164px; scroll-snap-align: start; }
    .nav {
      position: absolute; top: 34%; z-index: 3; display: none; place-items: center;
      width: 44px; height: 44px; padding: 0; border: 1px solid var(--cf-pink-border); border-radius: 50%;
      background: #fff; color: var(--cf-choco); font-size: 20px; cursor: pointer;
    }
    .nav:disabled { opacity: 0; pointer-events: none; }
    .nav:focus-visible { outline: none; box-shadow: 0 0 0 3px var(--cf-pink-accent); }
    .prev { left: calc(var(--inset) * -1 + 4px); }
    .next { right: calc(var(--inset) * -1 + 4px); }
    @media (hover: hover) and (pointer: fine) { .nav { display: grid; } }
  `,
})
export class RailComponent {
  /** Side padding of the surrounding container, so cards line up with the page edge. */
  readonly inset = input(20);
  /** Used in the arrow buttons' accessible names, e.g. "Halloween specials". */
  readonly label = input('cookies');

  private readonly track = viewChild.required<ElementRef<HTMLElement>>('track');
  readonly dragging = signal(false);
  readonly atStart = signal(true);
  readonly atEnd = signal(false);

  private pointerId: number | null = null;
  private startX = 0;
  private startScroll = 0;
  private moved = false;

  constructor() {
    afterNextRender(() => {
      this.updateEnds();
      // Capture phase, so the click is stopped before the cookie link underneath sees it.
      this.track().nativeElement.addEventListener('click', (event) => this.swallowClickAfterDrag(event), true);
    });
  }

  updateEnds(): void {
    const el = this.track().nativeElement;
    this.atStart.set(el.scrollLeft <= 2);
    this.atEnd.set(el.scrollLeft + el.clientWidth >= el.scrollWidth - 2);
  }

  step(direction: 1 | -1): void {
    const el = this.track().nativeElement;
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    el.scrollBy({ left: direction * el.clientWidth * 0.8, behavior: reduce ? 'auto' : 'smooth' });
  }

  startDrag(event: PointerEvent): void {
    if (event.pointerType !== 'mouse' || event.button !== 0) return;
    this.pointerId = event.pointerId;
    this.startX = event.clientX;
    this.startScroll = this.track().nativeElement.scrollLeft;
    this.moved = false;
  }

  drag(event: PointerEvent): void {
    if (event.pointerId !== this.pointerId) return;
    const dx = event.clientX - this.startX;
    if (!this.moved && Math.abs(dx) < 6) return;
    if (!this.moved) {
      this.moved = true;
      this.dragging.set(true);
      this.track().nativeElement.setPointerCapture(event.pointerId);
    }
    this.track().nativeElement.scrollLeft = this.startScroll - dx;
  }

  endDrag(event: PointerEvent): void {
    if (event.pointerId !== this.pointerId) return;
    const el = this.track().nativeElement;
    if (el.hasPointerCapture(event.pointerId)) el.releasePointerCapture(event.pointerId);
    this.pointerId = null;
    this.dragging.set(false);
    this.updateEnds();
  }

  /** A drag should not also open the cookie it started on. */
  swallowClickAfterDrag(event: MouseEvent): void {
    if (!this.moved) return;
    this.moved = false;
    event.preventDefault();
    event.stopPropagation();
  }
}
