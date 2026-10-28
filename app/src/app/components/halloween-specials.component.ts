/**
 * @file halloween-specials.component.ts
 * @description Home "Halloween specials" banner: a moonlit night sky with bats, a spider web and a
 * pumpkin, a countdown to Halloween, and the cookie rail projected inside. Decorations are flat SVG
 * (no shadows), hidden from screen readers, and the bats stay still for reduced motion.
 */
import { Component, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import { IonIcon } from '@ionic/angular';

@Component({
  selector: 'app-halloween-specials',
  imports: [RouterLink, IonIcon],
  template: `
    <section class="hw cf-rise" aria-labelledby="halloween-title">
      <svg class="sky" viewBox="0 0 360 150" preserveAspectRatio="xMaxYMin slice" aria-hidden="true" focusable="false">
        <!-- crescent moon with a soft halo and a bat crossing it -->
        <defs>
          <mask id="cf-hw-crescent"><rect width="360" height="150" fill="#fff" /><circle cx="333" cy="22" r="17" fill="#000" /></mask>
        </defs>
        <circle cx="322" cy="30" r="34" class="halo" /><circle cx="322" cy="30" r="26" class="halo" />
        <circle cx="322" cy="30" r="19" class="moon" mask="url(#cf-hw-crescent)" />
        <circle cx="311" cy="34" r="1.8" class="crater" /><circle cx="316" cy="42" r="1.3" class="crater" />
        <path class="moon-bat" d="M316 28c2-3 4-3 6-1 1-1 2-1 3 0 2-2 4-2 6 1-2-1-4 0-5 2-1-1-2-1-3 0-1-1-2-1-3 0-1-2-2-2-4-2z" />
        <!-- stars -->
        <g class="stars">
          <circle cx="210" cy="20" r="1.6" /><circle cx="248" cy="86" r="1.2" /><circle cx="338" cy="96" r="1.4" />
          <circle cx="182" cy="58" r="1" /><circle cx="262" cy="14" r="1.1" />
        </g>
        <!-- bats -->
        <g class="bat b1"><path d="M0 0c4-6 9-7 12-3 2-3 4-3 6 0 3-4 8-3 12 3-5-2-8-1-10 3-2-2-4-2-6 0-2-2-4-2-6 0-2-4-5-5-8-3z" /></g>
        <g class="bat b2"><path d="M0 0c4-6 9-7 12-3 2-3 4-3 6 0 3-4 8-3 12 3-5-2-8-1-10 3-2-2-4-2-6 0-2-2-4-2-6 0-2-4-5-5-8-3z" /></g>
      </svg>
      <!-- spider web, top-left corner -->
      <svg class="web" viewBox="0 0 70 70" aria-hidden="true" focusable="false">
        <path d="M0 0L70 0M0 0L0 70M0 0L60 35M0 0L35 60M0 0L66 14M0 0L14 66" />
        <path d="M16 0Q12 8 14 15Q8 12 0 16M32 0Q24 14 28 28Q14 24 0 32M50 0Q38 20 44 44Q20 38 0 50" />
        <line x1="22" y1="22" x2="22" y2="40" class="thread" /><circle cx="22" cy="43" r="3.2" class="spider" />
      </svg>

      <header class="head">
        <span class="mark" aria-hidden="true">
          <svg viewBox="0 0 40 40"><path class="stem" d="M19 7c0-3 2-5 5-5" /><ellipse cx="20" cy="23" rx="15" ry="12" class="pumpkin" /><path class="ridge" d="M20 11v24M12 13c-3 6-3 14 0 20M28 13c3 6 3 14 0 20" /><path class="face" d="M13 20l3-3 3 3zM21 20l3-3 3 3zM13 27c4 3 10 3 14 0l-2 2-2-1-2 2-2-2-2 1z" /></svg>
        </span>
        <div class="titles">
          @if (daysLeft() !== null) {
            <span class="tag" role="status">
              <ion-icon name="hourglass-outline" aria-hidden="true"></ion-icon>
              {{ daysLeft() === 0 ? 'Last day!' : daysLeft() === 1 ? '1 day left' : daysLeft() + ' days left' }}
            </span>
          } @else {
            <span class="tag">Limited time</span>
          }
          <h2 id="halloween-title">Halloween specials</h2>
          <p>{{ daysLeft() !== null ? 'Spooky bakes, only until November 30' : 'Seasonal bakes, while they last' }}</p>
        </div>
        <a class="see-all" routerLink="/shop" [queryParams]="{ show: 'halloween' }">
          See all <ion-icon name="chevron-forward" aria-hidden="true"></ion-icon>
        </a>
      </header>

      <div class="rail"><ng-content /></div>
      <div class="candy" aria-hidden="true"></div>
    </section>
  `,
  styles: `
    :host { display: block; margin-bottom: 22px; }
    .hw {
      position: relative; overflow: hidden; padding: 18px 0 14px;
      border: 1px solid var(--cf-hw-plum); border-radius: var(--cf-radius-lg);
      background: linear-gradient(160deg, var(--cf-hw-night) 0%, var(--cf-hw-plum) 70%, var(--cf-hw-night) 100%);
      color: var(--cf-hw-moon);
    }
    .sky { position: absolute; inset: 0 0 auto auto; width: 100%; height: 150px; pointer-events: none; }
    .moon { fill: var(--cf-hw-moon); }
    .halo { fill: var(--cf-hw-candy); opacity: .08; }
    .crater { fill: var(--cf-hw-candy); opacity: .45; }
    .moon-bat { fill: var(--cf-hw-night); }
    .stars circle { fill: var(--cf-hw-moon); opacity: .8; }
    .bat path { fill: var(--cf-hw-night); }
    .b1 { transform: translate(228px, 58px) scale(.9); animation: flap 3.2s ease-in-out infinite; }
    .b2 { transform: translate(318px, 84px) scale(.6); animation: flap 2.6s ease-in-out .8s infinite; }
    @keyframes flap { 50% { translate: 0 -5px; } }
    .web { position: absolute; top: 0; left: 0; width: 70px; height: 70px; pointer-events: none; opacity: .32; }
    .web path, .web .thread { fill: none; stroke: var(--cf-hw-moon); stroke-width: .8; }
    .web .spider { fill: var(--cf-hw-moon); }
    @media (prefers-reduced-motion: reduce) { .b1, .b2 { animation: none; } }

    .head { position: relative; display: flex; align-items: center; gap: 12px; margin: 0 18px 14px; }
    .mark { display: grid; place-items: center; flex: none; width: 46px; height: 46px; border-radius: 14px; background: var(--cf-hw-night); border: 1px solid var(--cf-hw-pumpkin); }
    .mark svg { width: 34px; height: 34px; }
    .pumpkin { fill: var(--cf-hw-pumpkin); }
    .ridge { fill: none; stroke: var(--cf-hw-night); stroke-width: 1.4; opacity: .35; }
    .stem { fill: none; stroke: var(--cf-hw-candy); stroke-width: 3; stroke-linecap: round; }
    .face { fill: var(--cf-hw-night); }
    .titles { flex: 1; min-width: 0; }
    .tag {
      display: inline-flex; align-items: center; gap: 4px; padding: 3px 9px; border-radius: 999px;
      background: var(--cf-hw-pumpkin); color: var(--cf-hw-night);
      font-size: .6rem; font-weight: 800; letter-spacing: .12em; text-transform: uppercase;
    }
    h2 { margin: 5px 0 2px; font-family: var(--cf-font-display); font-size: 1.3rem; line-height: 1.15; color: var(--cf-hw-moon); }
    p { margin: 0; font-size: .76rem; font-weight: 600; color: var(--cf-hw-candy); }
    .see-all {
      display: inline-flex; align-items: center; gap: 2px; align-self: flex-end; min-height: 44px;
      color: var(--cf-hw-candy); font-size: .8rem; font-weight: 800; text-decoration: none; white-space: nowrap;
    }
    .see-all:focus-visible { outline: 2px solid var(--cf-hw-pumpkin); outline-offset: 2px; border-radius: 8px; }
    .rail { position: relative; margin: 0 18px; }
    /* candy-corn stripe along the bottom edge */
    .candy {
      position: absolute; left: 0; right: 0; bottom: 0; height: 5px;
      background: repeating-linear-gradient(90deg, var(--cf-hw-pumpkin) 0 18px, var(--cf-hw-candy) 18px 30px, var(--cf-hw-moon) 30px 38px);
    }
  `,
})
export class HalloweenSpecialsComponent {
  /** Days left in the Halloween season (ends Nov 30), or null outside it. */
  readonly daysLeft = input<number | null>(null);
}
