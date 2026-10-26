/**
 * @file verification-modal.component.spec.ts
 * @description Verification sheet behavior: delivery-off notice, code entry, verify dismiss,
 * resend, and cancel.
 */
import { signal } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { ModalController } from '@ionic/angular';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { VerificationOperation, VerificationService } from '../core/verification.service';
import { VerificationModalComponent } from './verification-modal.component';

describe('VerificationModalComponent', () => {
  const verification = {
    start: vi.fn(),
    verify: vi.fn(),
  };
  const modal = { dismiss: vi.fn(async () => true) };

  beforeEach(() => {
    vi.clearAllMocks();
    TestBed.configureTestingModule({ providers: [
      { provide: VerificationService, useValue: verification },
      { provide: ModalController, useValue: modal },
    ] });
  });

  function component(operation: VerificationOperation = 'change_phone') {
    const ref = TestBed.runInInjectionContext(() => new VerificationModalComponent());
    // Stub the required signal inputs for the unit test (no template binding here).
    Object.defineProperty(ref, 'operation', { value: () => operation });
    Object.defineProperty(ref, 'target', { value: () => null });
    return ref;
  }

  it('shows an honest unavailable state when delivery is not enabled', async () => {
    verification.start.mockResolvedValue({
      challengeId: 'c1', operation: 'change_phone', channel: 'email',
      maskedDestination: 'm•••@example.test', expiresInMinutes: 10, delivered: false, deliveryEnabled: false,
    });
    const c = component();
    await c.ngOnInit();
    await Promise.resolve();
    expect(c.unavailable()).toBe(true);
    expect(c.started()).toBeNull(); // no code entry presented
  });

  it('starts a challenge and verifies a 6-digit code, dismissing with the result', async () => {
    verification.start.mockResolvedValue({
      challengeId: 'c1', operation: 'change_phone', channel: 'email',
      maskedDestination: 'm•••@example.test', expiresInMinutes: 10, delivered: true, deliveryEnabled: true,
    });
    verification.verify.mockResolvedValue({ verified: true, challengeId: 'c1', operation: 'change_phone' });
    const c = component();
    await c.ngOnInit();
    await Promise.resolve();
    expect(c.unavailable()).toBe(false);
    expect(c.started()?.challengeId).toBe('c1');

    c.onCode('12ab34cd56'); // non-digits stripped, capped at 6
    expect(c.code()).toBe('123456');
    await c.submit();
    expect(verification.verify).toHaveBeenCalledWith('c1', 'change_phone', '123456', null);
    expect(modal.dismiss).toHaveBeenCalledWith(
      { verified: true, challengeId: 'c1', operation: 'change_phone' }, 'verified',
    );
  });

  it('keeps the entered code only as digits and clears on a failed verify', async () => {
    verification.start.mockResolvedValue({
      challengeId: 'c1', operation: 'change_email', channel: 'email',
      maskedDestination: null, expiresInMinutes: 10, delivered: true, deliveryEnabled: true,
    });
    verification.verify.mockRejectedValue(new Error('bad code'));
    const c = component('change_email');
    await c.ngOnInit();
    await Promise.resolve();
    c.onCode('654321');
    await c.submit();
    expect(c.error()).toBeTruthy();
    expect(c.code()).toBe(''); // cleared for re-entry
    expect(modal.dismiss).not.toHaveBeenCalled();
  });

  it('shows a delivery-failure state (not a code field) when delivery is enabled but nothing was sent', async () => {
    verification.start.mockResolvedValue({
      challengeId: null, operation: 'change_phone', channel: 'email',
      maskedDestination: 'm•••@example.test', expiresInMinutes: 10,
      delivered: false, deliveryFailed: true, canRetry: true, deliveryEnabled: true,
    });
    const c = component();
    await c.ngOnInit();
    await Promise.resolve();
    expect(c.unavailable()).toBe(false);
    expect(c.deliveryFailed()).toBe(true);
    expect(c.started()).toBeNull(); // never present a code field for an unsent email
    expect(c.retryIn()).toBe(0); // confirmed rejection allows an immediate retry
  });

  it('gates retry with a countdown when the delivery outcome is ambiguous', async () => {
    verification.start.mockResolvedValue({
      challengeId: 'c-amb', operation: 'change_phone', channel: 'email',
      maskedDestination: 'm•••@example.test', expiresInMinutes: 10,
      delivered: false, deliveryFailed: true, canRetry: false, deliveryEnabled: true,
    });
    const c = component();
    await c.ngOnInit();
    await Promise.resolve();
    expect(c.deliveryFailed()).toBe(true);
    expect(c.started()).toBeNull();
    expect(c.retryIn()).toBeGreaterThan(0); // must wait before retrying to avoid a duplicate send
  });

  it('retryDelivery starts a fresh challenge and can recover into a delivered state', async () => {
    verification.start
      .mockResolvedValueOnce({
        challengeId: null, operation: 'change_phone', channel: 'email',
        maskedDestination: 'm•••@example.test', expiresInMinutes: 10,
        delivered: false, deliveryFailed: true, canRetry: true, deliveryEnabled: true,
      })
      .mockResolvedValueOnce({
        challengeId: 'c-ok', operation: 'change_phone', channel: 'email',
        maskedDestination: 'm•••@example.test', expiresInMinutes: 10,
        delivered: true, deliveryEnabled: true,
      });
    const c = component();
    await c.ngOnInit();
    await Promise.resolve();
    expect(c.deliveryFailed()).toBe(true);

    await c.retryDelivery();
    await Promise.resolve();
    expect(c.deliveryFailed()).toBe(false);
    expect(c.started()?.challengeId).toBe('c-ok');
  });

  it('does not submit when there is no delivered challenge id', async () => {
    verification.start.mockResolvedValue({
      challengeId: null, operation: 'change_phone', channel: 'email',
      maskedDestination: null, expiresInMinutes: 10,
      delivered: false, deliveryFailed: true, canRetry: true, deliveryEnabled: true,
    });
    const c = component();
    await c.ngOnInit();
    await Promise.resolve();
    c.onCode('123456');
    await c.submit();
    expect(verification.verify).not.toHaveBeenCalled();
  });

  it('shows a cooldown waiting state with a countdown on HTTP 429, without auto-resending', async () => {
    verification.start.mockRejectedValueOnce(
      new HttpErrorResponse({ status: 429, error: { message: 'Please wait a moment before requesting another code.', retryAfter: 42 } }),
    );
    const c = component();
    await c.ngOnInit();
    await Promise.resolve();
    expect(c.cooldown()).toBe(true);
    expect(c.started()).toBeNull();        // no code entry for a request that was throttled
    expect(c.unavailable()).toBe(false);
    expect(c.retryIn()).toBe(42);          // countdown seeded from the server Retry-After
    expect(verification.start).toHaveBeenCalledTimes(1); // no automatic resend
  });

  it('falls back to a 60s cooldown countdown when Retry-After is absent', async () => {
    verification.start.mockRejectedValueOnce(new HttpErrorResponse({ status: 429, error: { message: 'wait' } }));
    const c = component();
    await c.ngOnInit();
    await Promise.resolve();
    expect(c.cooldown()).toBe(true);
    expect(c.retryIn()).toBe(60);
  });

  it('retryAfterCooldown is blocked while the countdown is active and does not resend', async () => {
    verification.start.mockRejectedValueOnce(
      new HttpErrorResponse({ status: 429, error: { message: 'wait', retryAfter: 30 } }),
    );
    const c = component();
    await c.ngOnInit();
    await Promise.resolve();
    expect(verification.start).toHaveBeenCalledTimes(1);
    await c.retryAfterCooldown(); // retryIn > 0, so this must be a no-op
    expect(verification.start).toHaveBeenCalledTimes(1);
  });

  it('retryAfterCooldown starts a fresh challenge once the countdown has elapsed', async () => {
    verification.start.mockRejectedValueOnce(
      new HttpErrorResponse({ status: 429, error: { message: 'wait', retryAfter: 30 } }),
    );
    verification.start.mockResolvedValueOnce({
      challengeId: 'c-after', operation: 'change_phone', channel: 'email',
      maskedDestination: 'm•••@example.test', expiresInMinutes: 10, delivered: true, deliveryEnabled: true,
    });
    const c = component();
    await c.ngOnInit();
    await Promise.resolve();
    c.retryIn.set(0); // simulate the countdown reaching zero
    await c.retryAfterCooldown();
    await Promise.resolve();
    expect(c.cooldown()).toBe(false);
    expect(c.started()?.challengeId).toBe('c-after');
    expect(verification.start).toHaveBeenCalledTimes(2);
  });

  it('cancels by dismissing with a cancel role', () => {
    const c = component();
    c.cancel();
    expect(modal.dismiss).toHaveBeenCalledWith(null, 'cancel');
  });
});
