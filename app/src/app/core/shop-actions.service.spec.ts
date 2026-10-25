/**
 * @file shop-actions.service.spec.ts
 * @description Pack-picker host configuration and keyboard-focus restoration tests.
 */
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { AlertController, ModalController } from '@ionic/angular';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthService } from './auth.service';
import { BoxBuilderService } from './box-builder.service';
import { CartService } from './cart.service';
import { Product } from './models';
import { ShopActionsService } from './shop-actions.service';
import { UiService } from './ui.service';
import { ProductService } from './product.service';

describe('ShopActionsService pack picker', () => {
  const overlay = {
    present: vi.fn(async () => undefined),
    onDidDismiss: vi.fn(async () => ({ data: null, role: 'cancel' })),
  };
  const modals = { create: vi.fn(async () => overlay) };
  const products = {
    getLiveById: vi.fn(async (id: number) => ({ id, name: 'Oreo Cookies & Cream', isAvailable: true } as Product)),
    refreshForCommerce: vi.fn(async () => true),
  };
  const cart = { add: vi.fn(async () => undefined) };
  const ui = { toast: vi.fn(async () => undefined) };

  beforeEach(() => {
    vi.clearAllMocks();
    TestBed.configureTestingModule({ providers: [
      ShopActionsService,
      { provide: AuthService, useValue: { isLoggedIn: () => true } },
      { provide: CartService, useValue: cart },
      { provide: ProductService, useValue: products },
      { provide: BoxBuilderService, useValue: {} },
      { provide: UiService, useValue: ui },
      { provide: Router, useValue: {} },
      { provide: AlertController, useValue: {} },
      { provide: ModalController, useValue: modals },
    ] });
  });

  afterEach(() => document.querySelector('[data-pack-trigger]')?.remove());

  it('uses the dedicated bounded sheet and restores its keyboard trigger', async () => {
    const trigger = document.createElement('button');
    trigger.dataset['packTrigger'] = 'true';
    document.body.append(trigger);
    trigger.focus();

    await TestBed.inject(ShopActionsService).choosePack({ id: 12 } as Product);

    expect(modals.create).toHaveBeenCalledWith(expect.objectContaining({
      cssClass: ['cf-sheet', 'pack-picker'], breakpoints: [0, 1], initialBreakpoint: 1,
    }));
    expect(document.activeElement).toBe(trigger);
  });

  it('does not open ordering controls when current product data cannot be checked', async () => {
    products.getLiveById.mockRejectedValueOnce(new Error('offline'));
    await TestBed.inject(ShopActionsService).choosePack({ id: 12 } as Product);
    expect(modals.create).not.toHaveBeenCalled();
    expect(ui.toast).toHaveBeenCalledWith(
      'Connect to the internet to check current prices and availability before ordering.',
      { error: true },
    );
  });

  it('uses the live product check before writing to the server cart', async () => {
    const result = TestBed.inject(ShopActionsService).addSingle({ id: 12, name: 'Old name' } as Product, 2);
    await expect(result).resolves.toBe(true);
    expect(products.getLiveById).toHaveBeenCalledWith(12);
    expect(cart.add).toHaveBeenCalledWith(12, 2);
  });

  it('keeps the box builder read-only when the live catalog cannot be reached', async () => {
    products.refreshForCommerce.mockResolvedValueOnce(false);
    TestBed.inject(ShopActionsService).startBox(6);
    await vi.waitFor(() => expect(ui.toast).toHaveBeenCalledWith(
      'Connect to the internet to check current prices and availability before building a box.',
      { error: true },
    ));
  });
});
