/**
 * @file admin-feed.modal.ts
 * @description Admin notifications in the same full-screen format as the customer's: slides up over the
 * dashboard, X closes it, and the dashboard stays exactly where it was. Lists new orders, cancellation
 * requests and reviews; tapping one opens that order or the reviewed cookie.
 */
import { Component, inject } from '@angular/core';
import { IonButton, IonButtons, IonContent, IonHeader, IonIcon, IonTitle, IonToolbar, ModalController } from '@ionic/angular';
import { AdminFeedItem, AdminService } from '../core/admin.service';
import { relativeTime } from '../pages/notifications/notifications.page';

const KIND_ICON: Record<AdminFeedItem['kind'], string> = {
  order: 'receipt-outline',
  cancellation: 'alert-circle-outline',
  review: 'star-outline',
  message: 'mail-outline',
};

@Component({
  selector: 'app-admin-feed',
  // Same look as the customer notification center.
  styleUrls: ['../pages/notifications/notifications.page.scss'],
  imports: [IonHeader, IonToolbar, IonTitle, IonButtons, IonButton, IonIcon, IonContent],
  template: `
    <ion-header class="cf-header">
      <ion-toolbar>
        <ion-title class="cf-title">Notifications</ion-title>
        <ion-buttons slot="end">
          <ion-button (click)="close()" aria-label="Close notifications"><ion-icon slot="icon-only" name="close" aria-hidden="true"></ion-icon></ion-button>
        </ion-buttons>
      </ion-toolbar>
    </ion-header>
    <ion-content>
      <main class="cf-page notifications-page">
        @if (!admin.feed().length) {
          <aside class="empty-state">
            <span class="empty-mark"><ion-icon name="notifications-outline" aria-hidden="true"></ion-icon></span>
            <h2>No notifications yet</h2>
            <p>New orders, cancellation requests and reviews will show up here instantly.</p>
            <ion-button class="cf-btn-lg" (click)="close()">Back to dashboard</ion-button>
          </aside>
        } @else {
          @if (hasUnread()) {
            <div class="sheet-actions"><ion-button fill="clear" size="small" (click)="markAllRead()">Mark all read</ion-button></div>
          }
          <ul class="note-list">
            @for (item of admin.feed(); track item.kind + item.orderId + item.at) {
              <li>
                <button
                  type="button"
                  class="note-row cf-card"
                  [class.unread]="item.unread"
                  (click)="close(item)"
                  [attr.aria-label]="(item.unread ? 'Unread. ' : '') + item.title + '. ' + item.body"
                >
                  <span class="note-icon" [attr.data-category]="item.kind === 'order' ? 'order' : 'payment'">
                    <ion-icon [name]="icon[item.kind]" aria-hidden="true"></ion-icon>
                  </span>
                  <span class="note-copy">
                    <strong>{{ item.title }}</strong>
                    <small>{{ item.body }}</small>
                    <time [attr.datetime]="item.at">{{ ago(item.at) }}</time>
                  </span>
                  @if (item.unread) { <span class="unread-dot" aria-hidden="true"></span> }
                </button>
              </li>
            }
          </ul>
        }
      </main>
    </ion-content>
  `,
})
export class AdminFeedComponent {
  readonly admin = inject(AdminService);
  private modals = inject(ModalController);
  readonly icon = KIND_ICON;

  hasUnread(): boolean {
    return this.admin.feed().some((i) => i.unread);
  }

  ago(iso: string): string {
    return relativeTime(iso);
  }

  async markAllRead(): Promise<void> {
    await this.admin.markFeedSeen().catch(() => undefined);
  }

  /** Closes the sheet; when an item was tapped, hands it back so the dashboard can open it. */
  close(item?: AdminFeedItem): void {
    void this.modals.dismiss(item ?? null, item ? 'open' : 'cancel');
  }
}
