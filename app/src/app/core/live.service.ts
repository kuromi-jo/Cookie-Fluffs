/**
 * @file live.service.ts
 * @description Live updates from GET /api/live (Server-Sent Events read through fetch so the usual
 * Authorization header is sent). Keeps one stream open while logged in, reconnects with backoff,
 * refreshes the notification badge on its own, and exposes signals pages can react to.
 */
import { Injectable, effect, inject, signal } from '@angular/core';
import { environment } from '../../environments/environment';
import { AuthService } from './auth.service';
import { NotificationService } from './notification.service';

export interface LiveOrderChange {
  orderId: string;
  seq: number;
}

@Injectable({ providedIn: 'root' })
export class LiveService {
  private auth = inject(AuthService);
  private notifications = inject(NotificationService);

  /** Last customer order that changed (any status, payment or cancellation update). */
  readonly orderChange = signal<LiveOrderChange | null>(null);
  /** Bumped whenever shop-wide data changes; the admin dashboard listens to this. */
  readonly adminTick = signal(0);
  readonly connected = signal(false);

  private abort: AbortController | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryDelay = 1000;
  private seq = 0;

  constructor() {
    effect(() => {
      const token = this.auth.token();
      this.stop();
      if (token && this.auth.isLoggedIn()) void this.connect(token);
    });
  }

  private stop(): void {
    this.abort?.abort();
    this.abort = null;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.connected.set(false);
  }

  private async connect(token: string): Promise<void> {
    const controller = new AbortController();
    this.abort = controller;
    try {
      const res = await fetch(`${environment.apiUrl}/live`, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'text/event-stream' },
        signal: controller.signal,
        cache: 'no-store',
      });
      if (!res.ok || !res.body) throw new Error(`live ${res.status}`);
      this.connected.set(true);
      this.retryDelay = 1000;
      // Catch up on anything missed while disconnected.
      void this.notifications.refreshUnread();
      this.adminTick.update((n) => n + 1);

      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += value;
        let split: number;
        while ((split = buffer.indexOf('\n\n')) !== -1) {
          this.handle(buffer.slice(0, split));
          buffer = buffer.slice(split + 2);
        }
      }
    } catch {
      /* network drop, server restart or logout: retry below unless stopped */
    }
    this.connected.set(false);
    if (this.abort !== controller || controller.signal.aborted) return;
    this.retryTimer = setTimeout(() => void this.connect(token), this.retryDelay);
    this.retryDelay = Math.min(this.retryDelay * 2, 15000);
  }

  private handle(block: string): void {
    let event = 'message';
    let data = '';
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data += line.slice(5).trim();
    }
    let payload: Record<string, unknown> = {};
    try {
      payload = data ? JSON.parse(data) : {};
    } catch {
      return;
    }
    if (event === 'notification') {
      void this.notifications.refreshUnread();
      if (this.notifications.items().length) void this.notifications.load();
    } else if (event === 'order' && typeof payload['orderId'] === 'string') {
      this.orderChange.set({ orderId: payload['orderId'], seq: ++this.seq });
    } else if (event === 'admin') {
      this.adminTick.update((n) => n + 1);
    }
  }
}
