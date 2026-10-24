/**
 * @file pack-picker.modal.spec.ts
 * @description Pack-picker sheet sizing, quantity, dismissal, and selected-pack regressions.
 */
import { TestBed } from '@angular/core/testing';
import { ModalController } from '@ionic/angular';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PACK_PICKER_BREAKPOINTS,
  PACK_PICKER_INITIAL_BREAKPOINT,
  PackPickerComponent,
} from './pack-picker.modal';

describe('pack picker modal', () => {
  const modal = { dismiss: vi.fn(async () => true) };

  beforeEach(() => {
    vi.clearAllMocks();
    TestBed.configureTestingModule({ providers: [{ provide: ModalController, useValue: modal }] });
  });

  const picker = () => TestBed.runInInjectionContext(() => new PackPickerComponent());

  it('opens at its complete bounded sheet height', () => {
    expect(PACK_PICKER_BREAKPOINTS).toEqual([0, 1]);
    expect(PACK_PICKER_INITIAL_BREAKPOINT).toBe(1);
  });

  it('clamps single-cookie quantity and returns the selected choice', () => {
    const component = picker();
    component.change(-5);
    expect(component.qty()).toBe(1);
    component.change(30);
    expect(component.qty()).toBe(20);
    component.size.set(6);
    component.confirm();
    expect(modal.dismiss).toHaveBeenCalledWith({ size: 6, quantity: 1 }, 'confirm');
  });

  it('dismisses without a cart choice', () => {
    picker().close();
    expect(modal.dismiss).toHaveBeenCalledWith(null, 'cancel');
  });
});
