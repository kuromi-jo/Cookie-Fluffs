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

describe('ShopActionsService pack picker', () => {
  const overlay = {
    present: vi.fn(async () => undefined),
    onDidDismiss: vi.fn(async () => ({ data: null, role: 'cancel' })),
  };
  const modals = { create: vi.fn(async () => overlay) };

  beforeEach(() => {
    vi.clearAllMocks();
    TestBed.configureTestingModule({ providers: [
      ShopActionsService,
      { provide: AuthService, useValue: { isLoggedIn: () => true } },
      { provide: CartService, useValue: {} },
      { provide: BoxBuilderService, useValue: {} },
      { provide: UiService, useValue: {} },
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
});
