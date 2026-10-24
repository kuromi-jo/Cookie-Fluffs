/**
 * @file profile.page.spec.ts
 * @description Profile validation, editing, persistence, and authentication redirect tests.
 */
import { signal } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { AlertController } from '@ionic/angular';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthService } from '../../core/auth.service';
import { User } from '../../core/models';
import { UiService } from '../../core/ui.service';
import { ProfilePage, profileDraft, validateProfile } from './profile.page';
import { Router } from '@angular/router';

const initialUser: User = {
  id: 1,
  fullName: 'Maria Santos',
  firstName: 'Maria',
  lastName: 'Santos',
  email: 'maria@example.test',
  phone: '+639171234567',
  avatar: null,
  createdAt: '2026-01-01T00:00:00.000Z',
};

describe('ProfilePage', () => {
  const currentUser = signal<User | null>(initialUser);
  const auth = {
    user: currentUser,
    isLoggedIn: () => currentUser() !== null,
    refreshProfile: vi.fn(async () => undefined),
    updateProfile: vi.fn(async (changes: Partial<User>) => {
      const updated = {
        ...(currentUser() as User),
        ...changes,
        fullName: `${changes.firstName} ${changes.lastName}`,
      };
      currentUser.set(updated);
      return updated;
    }),
    logout: vi.fn(),
  };
  const router = { navigate: vi.fn(async () => true), navigateByUrl: vi.fn(async () => true) };
  const ui = { toast: vi.fn(async () => undefined) };
  const alerts = { create: vi.fn() };

  beforeEach(() => {
    currentUser.set(initialUser);
    vi.clearAllMocks();
    TestBed.configureTestingModule({
      providers: [
        { provide: AuthService, useValue: auth },
        { provide: Router, useValue: router },
        { provide: UiService, useValue: ui },
        { provide: AlertController, useValue: alerts },
      ],
    });
  });

  function page(): ProfilePage {
    return TestBed.runInInjectionContext(() => new ProfilePage());
  }

  it('maps authenticated profile data and validates names and Philippine phones', () => {
    expect(profileDraft(initialUser)).toEqual({
      firstName: 'Maria', lastName: 'Santos', phone: '+639171234567', avatar: null,
    });
    expect(validateProfile({ firstName: 'M', lastName: '', phone: '123', avatar: null }))
      .toEqual(expect.objectContaining({ firstName: expect.any(String), lastName: expect.any(String), phone: expect.any(String) }));
  });

  it('cancels edits without changing the authenticated profile', () => {
    const component = page();
    component.startEditing();
    component.update('firstName', 'Changed');
    component.cancelEditing();
    expect(component.editing()).toBe(false);
    expect(component.draft().firstName).toBe('Maria');
    expect(currentUser()?.firstName).toBe('Maria');
  });

  it('saves approved personal information and updates displayed profile state', async () => {
    const component = page();
    component.startEditing();
    component.update('firstName', 'Mara');
    component.update('lastName', 'Reyes');
    component.update('phone', '0918 765 4321');
    await component.save();
    expect(auth.updateProfile).toHaveBeenCalledWith({
      firstName: 'Mara', lastName: 'Reyes', phone: '0918 765 4321',
    });
    expect(component.editing()).toBe(false);
    expect(currentUser()?.fullName).toBe('Mara Reyes');
    expect(ui.toast).toHaveBeenCalledWith('Personal information updated.', { icon: 'checkmark-circle' });
  });

  it('does not send invalid profile edits', async () => {
    const component = page();
    component.startEditing();
    component.update('phone', '123');
    await component.save();
    expect(auth.updateProfile).not.toHaveBeenCalled();
    expect(component.fieldError('phone')).toContain('Philippine mobile number');
  });

  it('redirects guests to login with the profile return URL', async () => {
    currentUser.set(null);
    await page().ionViewWillEnter();
    expect(router.navigate).toHaveBeenCalledWith(['/login'], {
      queryParams: { returnUrl: '/profile' }, replaceUrl: true,
    });
  });

  it('clears an expired session and returns to login', async () => {
    auth.refreshProfile.mockRejectedValueOnce(new HttpErrorResponse({ status: 401 }));
    await page().ionViewWillEnter();
    expect(auth.logout).toHaveBeenCalledOnce();
    expect(router.navigate).toHaveBeenCalledWith(['/login'], {
      queryParams: { returnUrl: '/profile' }, replaceUrl: true,
    });
  });

  it('preserves the confirmed logout behavior', async () => {
    const present = vi.fn(async () => undefined);
    alerts.create.mockResolvedValueOnce({ present });
    await page().confirmLogout();
    const options = alerts.create.mock.calls[0][0];
    const logoutButton = options.buttons[1];
    logoutButton.handler();
    expect(present).toHaveBeenCalledOnce();
    expect(auth.logout).toHaveBeenCalledOnce();
    expect(router.navigateByUrl).toHaveBeenCalledWith('/home');
  });
});
