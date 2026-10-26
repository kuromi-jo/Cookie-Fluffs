/**
 * @file settings.page.spec.ts
 * @description Settings authentication, restoration, and save tests.
 */
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthService } from '../../core/auth.service';
import { PreferenceService } from '../../core/preference.service';
import { UiService } from '../../core/ui.service';
import { SettingsPage } from './settings.page';

describe('SettingsPage', () => {
  const auth = { isLoggedIn: vi.fn(() => true) };
  const preferences = {
    load: vi.fn(async () => ({ reduceMotion: true, largerText: false, notifyOrderUpdates: true, updatedAt: null })),
    save: vi.fn(async (value) => ({ ...value, updatedAt: 'now' })),
    preferences: () => ({ reduceMotion: false, largerText: false, notifyOrderUpdates: true, updatedAt: null }),
    loading: () => false, saving: () => false, error: () => '', systemReduceMotion: () => false,
  };
  const router = { navigate: vi.fn(async () => true) };
  const ui = { toast: vi.fn(async () => undefined) };

  beforeEach(() => {
    vi.clearAllMocks();
    auth.isLoggedIn.mockReturnValue(true);
    TestBed.configureTestingModule({ providers: [
      { provide: AuthService, useValue: auth }, { provide: PreferenceService, useValue: preferences },
      { provide: Router, useValue: router }, { provide: UiService, useValue: ui },
    ] });
  });

  const page = () => TestBed.runInInjectionContext(() => new SettingsPage());

  it('restores persisted values and saves only the approved settings', async () => {
    const component = page();
    await component.ionViewWillEnter();
    expect(component.reduceMotion()).toBe(true);
    component.largerText.set(true);
    await component.save();
    expect(preferences.save).toHaveBeenCalledWith({ reduceMotion: true, largerText: true, notifyOrderUpdates: true });
    expect(ui.toast).toHaveBeenCalledWith('App settings saved.', { icon: 'checkmark-circle' });
  });

  it('restores and saves the order-update notification preference', async () => {
    preferences.load.mockResolvedValueOnce({
      reduceMotion: false, largerText: false, notifyOrderUpdates: false, updatedAt: null,
    });
    const component = page();
    await component.ionViewWillEnter();
    expect(component.notifyOrderUpdates()).toBe(false);
    component.notifyOrderUpdates.set(true);
    await component.save();
    expect(preferences.save).toHaveBeenCalledWith({
      reduceMotion: false, largerText: false, notifyOrderUpdates: true,
    });
  });

  it('redirects guests to login with the settings destination', async () => {
    auth.isLoggedIn.mockReturnValue(false);
    await page().ionViewWillEnter();
    expect(router.navigate).toHaveBeenCalledWith(['/login'], {
      queryParams: { returnUrl: '/profile/settings' }, replaceUrl: true,
    });
  });
});
