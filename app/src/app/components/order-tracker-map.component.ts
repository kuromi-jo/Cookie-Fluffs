/**
 * @file order-tracker-map.component.ts
 * @description Order tracker map drawn from OpenStreetMap tiles (no map library or API key):
 * kitchen pin, delivery pin, the route between them, and a rider on a scooter.
 * Ready: the rider waits at the kitchen (hopping), the kitchen pulses and the route shimmers.
 * Out for delivery: the rider glides along the route facing its direction, leaves a fading trail,
 * the home pin pings and a live chip counts down the minutes. Completed: the home pin shows a check.
 * All motion stops for prefers-reduced-motion; the status chip still explains what is happening.
 */
import { Component, OnDestroy, computed, input, signal } from '@angular/core';

export interface MapPoint {
  lat: number;
  lng: number;
  label: string;
}

const W = 400;
const H = 230;
const PAD = 40;
const TILE = 256;
const DELIVERY_MINUTES = 25;
const TRAIL = [0.035, 0.07, 0.105];

/** Web-Mercator world pixel at (fractional) zoom z. */
function project(p: { lat: number; lng: number }, z: number): { x: number; y: number } {
  const scale = TILE * 2 ** z;
  const sin = Math.sin((p.lat * Math.PI) / 180);
  return {
    x: ((p.lng + 180) / 360) * scale,
    y: (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * scale,
  };
}

type Pt = { x: number; y: number };

/** Point on the quadratic route at t (0 kitchen, 1 door). */
function along(s: Pt, c: Pt, d: Pt, t: number): Pt {
  const u = 1 - t;
  return { x: u * u * s.x + 2 * u * t * c.x + t * t * d.x, y: u * u * s.y + 2 * u * t * c.y + t * t * d.y };
}

@Component({
  selector: 'app-order-tracker-map',
  template: `
    @if (view(); as v) {
      <figure class="tracker" [class]="'is-' + status()" [attr.aria-label]="ariaLabel()">
        <svg [attr.viewBox]="'0 0 ' + W + ' ' + H" preserveAspectRatio="xMidYMid slice" role="img" [attr.aria-label]="ariaLabel()">
          @for (t of v.tiles; track t.key) {
            <image [attr.href]="t.url" [attr.x]="t.x" [attr.y]="t.y" [attr.width]="v.size + 0.5" [attr.height]="v.size + 0.5" />
          }
          <rect [attr.width]="W" [attr.height]="H" class="tint" />
          @if (v.dest) {
            <path [attr.d]="v.path" class="route" [class.flowing]="moving()" />
            <path [attr.d]="v.path" class="route-done" pathLength="1" [attr.stroke-dasharray]="progress() + ' 1'" />
            <!-- home pin: pings while the rider is on the way, shows a check once delivered -->
            <g [attr.transform]="'translate(' + v.dest.x + ' ' + v.dest.y + ')'" class="pin home">
              @if (status() === 'out_for_delivery') { <circle r="15" class="ping" /><circle r="15" class="ping late" /> }
              <circle r="15" />
              @if (status() === 'completed') {
                <path class="check" d="M-6 0l4 4 8-8" />
              } @else {
                <path d="M-6 1 0-5 6 1v6h-12z" />
              }
            </g>
          }
          <!-- kitchen pin: pulses while the order is ready and waiting -->
          <g [attr.transform]="'translate(' + v.shop.x + ' ' + v.shop.y + ')'" class="pin shop">
            @if (status() === 'ready') { <circle r="15" class="ping" /><circle r="15" class="ping late" /> }
            <circle r="15" /><circle r="5.5" class="dot" />
          </g>
          @if (v.dest && rider(); as r) {
            @for (p of trail(); track $index) {
              <circle class="trail" [attr.cx]="p.x" [attr.cy]="p.y" [attr.r]="3.4 - $index" [style.opacity]="0.45 - $index * 0.13" />
            }
            <g class="rider" [style.transform]="'translate(' + r.x + 'px, ' + r.y + 'px)'">
              <g class="bob" [class.waiting]="status() === 'ready'" [class.riding]="status() === 'out_for_delivery'">
                <circle r="21" class="halo" />
                <g [style.transform]="r.flip ? 'scale(-1, 1)' : null">
                  <circle r="12" class="body" />
                  <!-- scooter: wheels, deck, handlebar and a little delivery box -->
                  <circle cx="-5" cy="5" r="2.4" class="wheel" /><circle cx="5.5" cy="5" r="2.4" class="wheel" />
                  <path class="frame" d="M-5 5h7l3.5-8h2.5M-1 5l-2-5" />
                  <rect x="-8" y="-6" width="6" height="5" rx="1" class="box" />
                </g>
              </g>
            </g>
          }
        </svg>
        @if (chip(); as c) {
          <div class="chip" role="status"><span class="live" aria-hidden="true"></span>{{ c }}</div>
        }
        <figcaption>
          <span class="legend"><i class="shop"></i>Kitchen</span>
          @if (destination()) { <span class="legend"><i class="home"></i>You</span> }
          <span class="osm">© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors</span>
        </figcaption>
      </figure>
    }
  `,
  styles: `
    .tracker { position: relative; margin: 0 0 14px; overflow: hidden; border: 1px solid var(--cf-pink-border); border-radius: 20px; background: var(--cf-pink-soft); }
    svg { display: block; width: 100%; height: auto; aspect-ratio: 400 / 230; }
    .tint { fill: var(--cf-canvas); opacity: .18; }
    .route { fill: none; stroke: var(--cf-choco-light); stroke-width: 4; stroke-dasharray: 2 8; stroke-linecap: round; }
    .route.flowing { stroke: var(--cf-pink-accent); animation: flow .9s linear infinite; }
    @keyframes flow { to { stroke-dashoffset: -20; } }
    .route-done { fill: none; stroke: var(--cf-pink-deep); stroke-width: 5; stroke-linecap: round; transition: stroke-dasharray 1s linear; }
    .pin circle { fill: #fff; stroke-width: 3; }
    .pin.shop circle { stroke: var(--cf-choco-btn); }
    .pin.shop .dot { fill: var(--cf-choco-btn); stroke: none; }
    .pin.home circle { stroke: var(--cf-pink-deep); }
    .pin.home path { fill: var(--cf-pink-deep); }
    .pin.home .check { fill: none; stroke: var(--ion-color-success); stroke-width: 3; stroke-linecap: round; stroke-linejoin: round; }
    .is-completed .pin.home circle { stroke: var(--ion-color-success); }
    .pin .ping { fill: none; stroke-width: 2.5; transform-box: fill-box; transform-origin: center; animation: ping 1.8s ease-out infinite; }
    .pin.shop .ping { stroke: var(--cf-choco-btn); }
    .pin.home .ping { stroke: var(--cf-pink-deep); }
    .pin .ping.late { animation-delay: .9s; }
    @keyframes ping { from { transform: scale(1); opacity: .7; } to { transform: scale(2.3); opacity: 0; } }
    .trail { fill: var(--cf-pink-deep); }
    .rider { transition: transform 1s linear; }
    .bob.waiting { animation: hop 1.1s ease-in-out infinite; }
    .bob.riding { animation: ride .5s ease-in-out infinite alternate; }
    @keyframes hop { 0%, 100% { transform: translateY(0); } 40% { transform: translateY(-5px); } 60% { transform: translateY(-5px); } }
    @keyframes ride { from { transform: translateY(0) rotate(-2deg); } to { transform: translateY(-1.5px) rotate(2deg); } }
    .halo { fill: var(--cf-pink-accent); opacity: .3; transform-box: fill-box; transform-origin: center; animation: breathe 1.6s ease-in-out infinite; }
    @keyframes breathe { 50% { transform: scale(1.25); opacity: .12; } }
    .body { fill: var(--cf-pink-deep); }
    .wheel { fill: #fff; }
    .frame { fill: none; stroke: #fff; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
    .box { fill: var(--cf-hw-candy); }
    .chip {
      position: absolute; top: 10px; left: 10px; display: inline-flex; align-items: center; gap: 7px; max-width: calc(100% - 20px);
      padding: 6px 12px; border: 1px solid var(--cf-pink-border); border-radius: 999px; background: #fff;
      color: var(--cf-choco); font-size: .76rem; font-weight: 800; animation: chip-in .4s ease-out;
    }
    .chip .live { flex: none; width: 8px; height: 8px; border-radius: 50%; background: var(--cf-pink-deep); animation: blink 1.2s ease-in-out infinite; }
    .is-completed .chip .live { background: var(--ion-color-success); animation: none; }
    @keyframes blink { 50% { opacity: .25; } }
    @keyframes chip-in { from { opacity: 0; transform: translateY(-6px); } }
    @media (prefers-reduced-motion: reduce) {
      .route.flowing, .pin .ping, .bob.waiting, .bob.riding, .halo, .chip, .chip .live { animation: none; }
      .pin .ping { display: none; }
      .rider, .route-done { transition: none; }
    }
    figcaption { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; padding: 8px 12px; background: #fff; font-size: .72rem; font-weight: 700; color: var(--cf-choco-medium); }
    .legend { display: inline-flex; align-items: center; gap: 5px; }
    .legend i { width: 10px; height: 10px; border-radius: 50%; border: 2.5px solid; }
    .legend .shop { border-color: var(--cf-choco-btn); }
    .legend .home { border-color: var(--cf-pink-deep); }
    .osm { margin-left: auto; font-weight: 600; color: var(--cf-choco-light); }
    .osm a { color: inherit; }
  `,
})
export class OrderTrackerMapComponent implements OnDestroy {
  readonly kitchen = input.required<MapPoint>();
  readonly destination = input<MapPoint | null>(null);
  readonly status = input.required<string>();
  /** When the order went out for delivery; drives how far along the route the rider is. */
  readonly outForDeliveryAt = input<string | null>(null);

  readonly W = W;
  readonly H = H;

  private readonly now = signal(Date.now());
  // One tick per second so the rider glides (CSS eases between ticks) and the minutes stay current.
  private readonly timer = setInterval(() => this.now.set(Date.now()), 1000);

  readonly moving = computed(() => ['ready', 'out_for_delivery'].includes(this.status()));

  readonly view = computed(() => {
    const shop = this.kitchen();
    const dest = this.destination();
    // Zoom (fractionally) so both pins fill the frame, then draw the nearest whole-zoom tiles scaled up.
    let zoom = 15;
    if (dest) {
      const a0 = project(shop, 0);
      const b0 = project(dest, 0);
      const fitX = (W - 2 * PAD) / Math.max(Math.abs(a0.x - b0.x), 1e-9);
      const fitY = (H - 2 * PAD) / Math.max(Math.abs(a0.y - b0.y), 1e-9);
      zoom = Math.max(3, Math.min(15, Math.log2(Math.min(fitX, fitY))));
    }
    const z = Math.floor(zoom);
    const size = TILE * 2 ** (zoom - z);
    const a = project(shop, zoom);
    const b = dest ? project(dest, zoom) : a;
    const origin = { x: (a.x + b.x) / 2 - W / 2, y: (a.y + b.y) / 2 - H / 2 };
    const tiles = [];
    const n = 2 ** z;
    for (let tx = Math.floor(origin.x / size); tx <= Math.floor((origin.x + W) / size); tx++) {
      for (let ty = Math.floor(origin.y / size); ty <= Math.floor((origin.y + H) / size); ty++) {
        if (ty < 0 || ty >= n) continue;
        const wrapped = ((tx % n) + n) % n;
        tiles.push({ key: `${z}/${tx}/${ty}`, url: `https://tile.openstreetmap.org/${z}/${wrapped}/${ty}.png`, x: tx * size - origin.x, y: ty * size - origin.y });
      }
    }
    const s = { x: a.x - origin.x, y: a.y - origin.y };
    const d = dest ? { x: b.x - origin.x, y: b.y - origin.y } : null;
    // A gentle curve reads more like a road route than a straight line.
    const c = d ? { x: (s.x + d.x) / 2 + (d.y - s.y) * 0.25, y: (s.y + d.y) / 2 - (d.x - s.x) * 0.25 } : null;
    return { tiles, size, shop: s, dest: d, ctrl: c, path: d && c ? `M${s.x} ${s.y} Q${c.x} ${c.y} ${d.x} ${d.y}` : '' };
  });

  /** Minutes since the order left the kitchen. */
  private readonly minutesOut = computed(() => {
    const at = this.outForDeliveryAt();
    return at ? Math.max(0, (this.now() - new Date(at).getTime()) / 60000) : 0;
  });

  /** 0 at the kitchen, 1 at the door. */
  readonly progress = computed(() => {
    const status = this.status();
    if (status === 'completed') return 1;
    if (status !== 'out_for_delivery') return 0;
    return Math.min(0.92, 0.08 + (this.minutesOut() / DELIVERY_MINUTES) * 0.84);
  });

  readonly rider = computed(() => {
    const v = this.view();
    const status = this.status();
    if (!v.dest || !v.ctrl || !['ready', 'out_for_delivery'].includes(status)) return null;
    // While ready, the rider waits just outside the kitchen.
    const t = status === 'ready' ? 0.06 : this.progress();
    const here = along(v.shop, v.ctrl, v.dest, t);
    const ahead = along(v.shop, v.ctrl, v.dest, Math.min(1, t + 0.02));
    return { ...here, flip: ahead.x < here.x };
  });

  /** Fading dots behind the moving rider. */
  readonly trail = computed(() => {
    const v = this.view();
    if (this.status() !== 'out_for_delivery' || !v.dest || !v.ctrl) return [];
    const t = this.progress();
    return TRAIL.filter((gap) => t - gap > 0).map((gap) => along(v.shop, v.ctrl!, v.dest!, t - gap));
  });

  /** Plain-language status shown on the map. */
  readonly chip = computed(() => {
    const status = this.status();
    const delivery = !!this.destination();
    if (status === 'ready') return delivery ? 'Packed and waiting for a rider' : 'Ready for pickup at the kitchen';
    if (status === 'out_for_delivery') {
      const left = Math.round(DELIVERY_MINUTES - this.minutesOut());
      return left <= 1 ? 'Rider is arriving any minute' : `Rider on the way · about ${left} min`;
    }
    if (status === 'completed') return delivery ? 'Delivered. Enjoy your cookies!' : 'Picked up. Enjoy your cookies!';
    if (status === 'preparing') return 'Your cookies are in the oven';
    return null;
  });

  readonly ariaLabel = computed(() => {
    const dest = this.destination();
    if (!dest) return `Map showing the ${this.kitchen().label}.`;
    const pct = Math.round(this.progress() * 100);
    return `Delivery map from the kitchen to ${dest.label}. ${this.chip() ?? ''} Your order is about ${pct}% of the way.`;
  });

  ngOnDestroy(): void {
    clearInterval(this.timer);
  }
}
