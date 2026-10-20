/**
 * @file splash.component.ts
 * @description Launch screen shown while the menu loads in the background.
 * Kept calm on purpose: the logo settles in, the name fades up, a slim bar fills.
 */
import { Component, input } from '@angular/core';

@Component({
  selector: 'app-splash',
  template: `
    <div class="splash" [class.leaving]="leaving()" role="status" aria-label="Cookie Fluffs is loading">
      <div class="center">
        <div class="mark">
          <span class="ring"></span>
          <span class="orbit" aria-hidden="true">
            @for (s of sprinkles; track $index) {
              <i [style.--a.deg]="s.angle" [style.background]="s.color"></i>
            }
          </span>
          <img class="logo" src="assets/brand/cookie-logo.svg" alt="" />
        </div>
        <h1>Cookie <em>Fluffs</em></h1>
        <p>Freshly baked</p>
      </div>
      <div class="foot">
        <div class="bar"><span></span></div>
      </div>
    </div>
  `,
  styles: `
    :host { position: absolute; inset: 0; z-index: 99999; display: block; }
    .splash {
      position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center;
      background: #fce7f3; transition: opacity .45s ease;
    }
    .splash.leaving { opacity: 0; pointer-events: none; }
    .center { display: flex; flex-direction: column; align-items: center; text-align: center; }
    .mark { position: relative; display: grid; place-items: center; width: 150px; height: 150px; margin-bottom: 22px; }
    .ring { position: absolute; inset: 0; border-radius: 50%; background: #fff5f7; animation: grow .8s cubic-bezier(.16,1,.3,1) both; }
    /* a few sprinkles slowly circling the logo */
    .orbit { position: absolute; inset: -14px; animation: orbit 14s linear infinite, appear .8s .6s ease both; }
    .orbit i {
      position: absolute; top: 50%; left: 50%; width: 10px; height: 4px; margin: -2px 0 0 -5px; border-radius: 4px;
      transform: rotate(var(--a)) translateX(89px) rotate(90deg);
    }
    @keyframes orbit { to { rotate: 360deg; } }
    @keyframes appear { from { opacity: 0; } to { opacity: 1; } }
    .logo { position: relative; width: 112px; height: 112px; animation: settle 1s .1s cubic-bezier(.16,1,.3,1) both; }
    h1 {
      margin: 0; font-family: var(--cf-font-display); font-size: 2.4rem; font-weight: 800; color: var(--cf-choco);
      animation: fade-up .8s .35s cubic-bezier(.16,1,.3,1) both;
    }
    h1 em { font-style: italic; color: var(--cf-pink-deep); }
    p {
      margin: 6px 0 0; font-size: .85rem; font-weight: 600; letter-spacing: .02em; color: var(--cf-choco-light);
      animation: fade-up .8s .5s cubic-bezier(.16,1,.3,1) both;
    }
    .foot { position: absolute; bottom: calc(48px + env(safe-area-inset-bottom)); width: 120px; }
    .bar { height: 4px; border-radius: 99px; background: #fbcfe8; overflow: hidden; }
    .bar span { display: block; height: 100%; width: 0; border-radius: 99px; background: var(--cf-choco-btn); animation: fill 2.3s .2s ease-in-out forwards; }
    @keyframes grow { from { transform: scale(.6); opacity: 0; } to { transform: none; opacity: 1; } }
    @keyframes settle { from { transform: rotate(-30deg) scale(.85); opacity: 0; } to { transform: none; opacity: 1; } }
    @keyframes fade-up { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: none; } }
    @keyframes fill { to { width: 100%; } }
    @media (prefers-reduced-motion: reduce) { .orbit, .ring, .logo, h1, p, .bar span { animation: none; } .bar span { width: 100%; } }
  `,
})
export class SplashComponent {
  readonly leaving = input(false);

  readonly sprinkles = [0, 45, 90, 135, 180, 225, 270, 315].map((angle, i) => ({
    angle,
    color: ['#f472b6', '#523628', '#f9a8d4', '#be185d'][i % 4],
  }));
}
