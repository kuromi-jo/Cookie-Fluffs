/**
 * @file contact.page.ts
 * @description Customer support message form.
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
      await this.ui.toast('Your message was saved.', { icon: 'send-outline' });
    } catch (err) {
      await this.ui.toast(apiErrorMessage(err), { error: true });
    } finally {
      this.sending.set(false);
    }
  }
}
