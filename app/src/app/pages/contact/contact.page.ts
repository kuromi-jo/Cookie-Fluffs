/**
 * @file contact.page.ts
 * @description Shop contact details and a message form (messages are saved to Neon).
 */
import { Component, inject, signal } from '@angular/core';
import { FormsModule, NgForm } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import {
  IonButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonIcon,
  IonInput,
  IonMenuButton,
  IonSelect,
  IonSelectOption,
  IonSpinner,
  IonTextarea,
  IonTitle,
  IonToolbar,
} from '@ionic/angular';
import { environment } from '../../../environments/environment';
import { AuthService } from '../../core/auth.service';
import { UiService } from '../../core/ui.service';
import { apiErrorMessage } from '../../core/api-error';

@Component({
  selector: 'app-contact',
  templateUrl: 'contact.page.html',
  styleUrls: ['../info-page.scss', 'contact.page.scss'],
  imports: [
    FormsModule,
    IonHeader,
    IonToolbar,
    IonButtons,
    IonMenuButton,
    IonTitle,
    IonContent,
    IonIcon,
    IonInput,
    IonTextarea,
    IonSelect,
    IonSelectOption,
    IonButton,
    IonSpinner,
  ],
})
export class ContactPage {
  private http = inject(HttpClient);
  private auth = inject(AuthService);
  private ui = inject(UiService);

  // Placeholder shop details: replace with your real ones.
  readonly shop = {
    phone: '0917 123 4567',
    phoneHref: 'tel:+639171234567',
    email: 'hello@cookiefluffs.ph',
    address: 'Cubao, Quezon City, Metro Manila',
    hours: 'Mon–Sat · 9:00 AM – 7:00 PM',
  };

  readonly subjects = ['General question', 'Order concern', 'Bulk / event order', 'Feedback', 'Partnership'];

  readonly sending = signal(false);
  readonly sent = signal(false);

  name = this.auth.user()?.fullName ?? '';
  email = this.auth.user()?.email ?? '';
  subject = this.subjects[0];
  message = '';

  async send(form: NgForm): Promise<void> {
    if (form.invalid) {
      form.control.markAllAsTouched();
      await this.ui.toast('Please complete the form first.', { error: true });
      return;
    }
    this.sending.set(true);
    try {
      await firstValueFrom(
        this.http.post(`${environment.apiUrl}/contact`, {
          name: this.name,
          email: this.email,
          subject: this.subject,
          message: this.message,
        }),
      );
      this.sent.set(true);
      this.message = '';
      form.resetForm({ name: this.name, email: this.email, subject: this.subject, message: '' });
      await this.ui.toast('Message sent! We will reply within 24 hours.', { icon: 'send-outline' });
    } catch (err) {
      await this.ui.toast(apiErrorMessage(err), { error: true });
    } finally {
      this.sending.set(false);
    }
  }
}
