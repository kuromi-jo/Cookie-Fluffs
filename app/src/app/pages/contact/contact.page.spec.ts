/**
 * @file contact.page.spec.ts
 * @description Contact form persistence and neutral success-message test.
 */
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthService } from '../../core/auth.service';
import { UiService } from '../../core/ui.service';
import { ContactPage } from './contact.page';

describe('ContactPage', () => {
  const auth = { user: () => null };
  const ui = { toast: vi.fn(async () => undefined) };
  let http: HttpTestingController;

  beforeEach(() => {
    vi.clearAllMocks();
    TestBed.configureTestingModule({ providers: [
      provideHttpClient(), provideHttpClientTesting(),
      { provide: AuthService, useValue: auth }, { provide: UiService, useValue: ui },
    ] });
    http = TestBed.inject(HttpTestingController);
  });
  afterEach(() => http.verify());

  it('saves a support message without promising a response time', async () => {
    const page = TestBed.runInInjectionContext(() => new ContactPage());
    page.name = 'Maria Santos';
    page.email = 'maria@example.test';
    page.message = 'Please help with my order.';
    const form = { invalid: false, resetForm: vi.fn(), control: { markAllAsTouched: vi.fn() } };
    const result = page.send(form as never);
    const request = http.expectOne('/api/contact');
    expect(request.request.body).toMatchObject({ name: 'Maria Santos', message: page.message });
    request.flush({ id: 1, createdAt: '2026-01-01' });
    await result;
    expect(ui.toast).toHaveBeenCalledWith('Your message was saved.', { icon: 'send-outline' });
  });
});
