/**
 * @file addresses.page.spec.ts
 * @description Address-list default and authentication behavior tests.
 */
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { AlertController } from '@ionic/angular';
import { Router } from '@angular/router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AddressService } from '../../core/address.service';
import { AuthService } from '../../core/auth.service';
import { SavedAddress } from '../../core/models';
import { UiService } from '../../core/ui.service';
import { AddressesPage } from './addresses.page';

const home = { id: 'home', label: 'Home', isDefault: false } as SavedAddress;

describe('AddressesPage', () => {
  const addressBook = { addresses: signal<SavedAddress[]>([home]), load: vi.fn(), setDefault: vi.fn(), delete: vi.fn() };
  const auth = { isLoggedIn: vi.fn(() => true) };
  const router = { navigate: vi.fn() };
  const ui = { toast: vi.fn() };
  const alerts = { create: vi.fn() };

  beforeEach(() => {
    vi.clearAllMocks();
    addressBook.addresses.set([home]);
    addressBook.load.mockResolvedValue([home]);
    addressBook.setDefault.mockResolvedValue({ ...home, isDefault: true });
    TestBed.configureTestingModule({ providers: [
      { provide: AddressService, useValue: addressBook },
      { provide: AuthService, useValue: auth },
      { provide: Router, useValue: router },
      { provide: UiService, useValue: ui },
      { provide: AlertController, useValue: alerts },
    ] });
  });

  it('loads persisted addresses when the authenticated page opens', async () => {
    await TestBed.runInInjectionContext(() => new AddressesPage()).ionViewWillEnter();
    expect(addressBook.load).toHaveBeenCalledOnce();
  });

  it('sets a non-default address and reports success', async () => {
    const page = TestBed.runInInjectionContext(() => new AddressesPage());
    await page.makeDefault(home);
    expect(addressBook.setDefault).toHaveBeenCalledWith('home');
    expect(ui.toast).toHaveBeenCalled();
  });
});
