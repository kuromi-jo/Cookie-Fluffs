import { Component, computed, input } from '@angular/core';
import { initials } from '../core/image';

/** Round user photo, falling back to initials on a pink circle. */
@Component({
  selector: 'app-avatar',
  template: `
    @if (src()) {
      <img [src]="src()" [alt]="name() + ' profile photo'" />
    } @else {
      <span aria-hidden="true">{{ letters() }}</span>
    }
  `,
  styles: `
    :host {
      display: inline-grid; place-items: center; flex: none; overflow: hidden; border-radius: 50%;
      width: var(--size, 56px); height: var(--size, 56px);
      background: linear-gradient(135deg, #f9a8d4, #f472b6);
      color: #fff; font-weight: 800; font-size: calc(var(--size, 56px) * .36);
      box-shadow: 0 0 0 3px #fff5f7;
    }
    img { width: 100%; height: 100%; object-fit: cover; }
  `,
})
export class AvatarComponent {
  readonly src = input<string | null | undefined>(null);
  readonly name = input('');
  readonly letters = computed(() => initials(this.name()));
}
