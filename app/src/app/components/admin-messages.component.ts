/**
 * @file admin-messages.component.ts
 * @description Admin "Messages" tab: Contact Us messages, newest first. Search by name, email, topic or
 * text; filter by topic and by who sent it (logged-in accounts or guests). Read only; "Reply by email"
 * opens the admin's mail app addressed to the customer.
 */
import { Component, OnDestroy, effect, inject, signal, untracked } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { IonButton, IonIcon, IonSearchbar, IonSelect, IonSelectOption, IonSpinner } from '@ionic/angular';
import { AdminMessage, AdminService } from '../core/admin.service';
import { LiveService } from '../core/live.service';
import { apiErrorMessage } from '../core/api-error';

type From = '' | 'accounts' | 'guests';

@Component({
  selector: 'app-admin-messages',
  imports: [DatePipe, FormsModule, IonButton, IonIcon, IonSearchbar, IonSelect, IonSelectOption, IonSpinner],
  template: `
    <div class="tools">
      <ion-searchbar class="search" placeholder="Search name, email or message" [debounce]="300" [value]="q()" (ionInput)="setQuery($event.detail.value)" aria-label="Search messages"></ion-searchbar>
      <div class="filters">
        <ion-select class="cf-input" label="Topic" labelPlacement="floating" interface="popover" [value]="topic()" (ionChange)="topic.set($event.detail.value); reload()">
          <ion-select-option value="">All topics</ion-select-option>
          @for (t of admin.messages()?.topics ?? []; track t) { <ion-select-option [value]="t">{{ t }}</ion-select-option> }
        </ion-select>
        <div class="chips" role="group" aria-label="Sent by">
          @for (f of fromOptions; track f.value) {
            <button type="button" class="chip" [class.on]="from() === f.value" [attr.aria-pressed]="from() === f.value" (click)="from.set(f.value); reload()">{{ f.label }}</button>
          }
        </div>
      </div>
    </div>

    @if (error()) {
      <div class="state cf-card" role="alert">
        <ion-icon name="cloud-offline-outline" aria-hidden="true"></ion-icon>
        <p>{{ error() }}</p>
        <ion-button fill="outline" (click)="reload()">Try again</ion-button>
      </div>
    } @else if (!admin.messages()) {
      <div class="center" role="status"><ion-spinner name="crescent"></ion-spinner></div>
    } @else {
      @let list = admin.messages()!;
      <p class="count" role="status">{{ list.messages.length }} of {{ list.total }} {{ list.total === 1 ? 'message' : 'messages' }}</p>
      @for (m of list.messages; track m.id) {
        <article class="msg cf-card">
          <header>
            <div>
              <strong>{{ m.name }}</strong>
              <small>{{ m.email }}@if (m.accountPhone) { · {{ m.accountPhone }}}</small>
            </div>
            <span class="tag" [class.guest]="!m.fromAccount">{{ m.fromAccount ? 'Account' : 'Guest' }}</span>
          </header>
          <p class="topic"><ion-icon name="chatbubble-ellipses-outline" aria-hidden="true"></ion-icon>{{ m.topic }} · {{ m.createdAt | date: 'MMM d, h:mm a' }}</p>
          <p class="text" [class.open]="expanded().has(m.id)">{{ m.message }}</p>
          <div class="actions">
            @if (m.message.length > 160) {
              <ion-button fill="clear" size="small" (click)="toggle(m.id)">{{ expanded().has(m.id) ? 'Show less' : 'Read more' }}</ion-button>
            }
            <ion-button fill="outline" size="small" (click)="reply(m)"><ion-icon slot="start" name="mail-outline" aria-hidden="true"></ion-icon>Reply by email</ion-button>
          </div>
        </article>
      } @empty {
        <div class="state cf-card">
          <ion-icon name="mail-outline" aria-hidden="true"></ion-icon>
          <h3>{{ filtered() ? 'No messages match' : 'No messages yet' }}</h3>
          <p>{{ filtered() ? 'Try a different search or filter.' : 'Messages sent through Contact Us appear here instantly.' }}</p>
          @if (filtered()) { <ion-button fill="outline" (click)="clear()">Clear search and filters</ion-button> }
        </div>
      }
    }
  `,
  styles: `
    .tools { display: grid; gap: 8px; margin-bottom: 10px; }
    .search { --background: #fff; --border-radius: 999px; --placeholder-color: var(--cf-choco-light); padding: 0; }
    .filters { display: grid; gap: 8px; }
    .filters ion-select { margin: 0; }
    .chips { display: flex; gap: 6px; flex-wrap: wrap; }
    .chip { min-height: 36px; padding: 0 14px; border: 1.5px solid var(--cf-pink-border); border-radius: 999px; background: #fff; color: var(--cf-choco); font: inherit; font-size: .8rem; font-weight: 800; cursor: pointer; }
    .chip.on { border-color: var(--cf-choco-btn); background: var(--cf-choco-btn); color: var(--cf-canvas); }
    .chip:focus-visible { outline: none; box-shadow: 0 0 0 3px var(--cf-pink-accent); }
    .count { margin: 4px 2px 10px; font-size: .76rem; font-weight: 700; color: var(--cf-choco-light); }
    .msg { margin-bottom: 10px; padding: 14px; border: 1px solid var(--cf-pink-border); }
    .msg header { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; }
    .msg header div { display: flex; flex-direction: column; min-width: 0; }
    .msg strong { font-size: .95rem; color: var(--cf-choco); }
    .msg small { font-size: .74rem; color: var(--cf-choco-light); overflow-wrap: anywhere; }
    .tag { flex: none; padding: 3px 10px; border-radius: 999px; background: var(--cf-pink-soft); color: var(--cf-pink-deep); font-size: .68rem; font-weight: 800; }
    .tag.guest { background: var(--cf-canvas); color: var(--cf-choco-medium); border: 1px solid var(--cf-pink-border); }
    .topic { display: flex; align-items: center; gap: 5px; margin: 8px 0 4px; font-size: .76rem; font-weight: 700; color: var(--cf-choco-medium); }
    .text { margin: 0; font-size: .88rem; line-height: 1.5; color: var(--cf-choco); white-space: pre-wrap; overflow-wrap: anywhere;
      display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
    .text.open { display: block; }
    .actions { display: flex; justify-content: flex-end; gap: 6px; margin-top: 8px; }
    .state { display: grid; justify-items: center; gap: 6px; padding: 28px 20px; text-align: center; color: var(--cf-choco-medium); }
    .state > ion-icon { padding: 14px; border-radius: 20px; background: var(--cf-pink-soft); color: var(--cf-pink-deep); font-size: 28px; }
    .state h3 { margin: 4px 0 0; font-family: var(--cf-font-display); color: var(--cf-choco); }
    .state p { margin: 0 0 6px; font-size: .86rem; }
    .center { display: grid; place-items: center; padding: 40px; }
  `,
})
export class AdminMessagesComponent implements OnDestroy {
  readonly admin = inject(AdminService);
  private live = inject(LiveService);

  readonly fromOptions: { value: From; label: string }[] = [
    { value: '', label: 'Everyone' },
    { value: 'accounts', label: 'From accounts' },
    { value: 'guests', label: 'Guests' },
  ];
  readonly q = signal('');
  readonly topic = signal('');
  readonly from = signal<From>('');
  readonly error = signal('');
  readonly expanded = signal<ReadonlySet<number>>(new Set());
  private seq = 0;

  /** New messages arrive live; reload with the current search and filters. */
  private readonly liveRefresh = effect(() => {
    if (!this.live.adminTick()) return;
    untracked(() => void this.reload());
  });

  constructor() {
    void this.reload();
  }

  filtered(): boolean {
    return !!(this.q().trim() || this.topic() || this.from());
  }

  setQuery(value: string | null | undefined): void {
    this.q.set(value ?? '');
    void this.reload();
  }

  async reload(): Promise<void> {
    const seq = ++this.seq;
    try {
      await this.admin.loadMessages({ q: this.q(), topic: this.topic(), from: this.from() });
      if (seq === this.seq) this.error.set('');
    } catch (err) {
      if (seq === this.seq) this.error.set(apiErrorMessage(err));
    }
  }

  clear(): void {
    this.q.set('');
    this.topic.set('');
    this.from.set('');
    void this.reload();
  }

  toggle(id: number): void {
    this.expanded.update((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  reply(m: AdminMessage): void {
    window.location.href = `mailto:${encodeURIComponent(m.email)}?subject=${encodeURIComponent('Re: ' + m.topic)}`;
  }

  ngOnDestroy(): void {
    this.seq++;
  }
}
