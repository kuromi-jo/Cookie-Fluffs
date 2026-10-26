/**
 * @file google-auth.service.spec.ts
 * @description GIS web lifecycle: default one-init-per-page guard (login/signup), opt-in
 * reinitialization for step-up reauth, and attempt-isolation so a superseded/canceled attempt's
 * credential callback cannot fire for a newer attempt.
 */
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GoogleAuthService } from './google-auth.service';

describe('GoogleAuthService web GIS lifecycle', () => {
  let initConfigs: Array<{ nonce: string; callback: (r: { credential?: string }) => void }>;
  let service: GoogleAuthService;

  beforeEach(() => {
    initConfigs = [];
    // Stub the GIS global so loadWebLibrary short-circuits and initialize/renderButton are observable.
    (window as unknown as { google: unknown }).google = {
      accounts: {
        id: {
          initialize: (cfg: { nonce: string; callback: (r: { credential?: string }) => void }) => {
            initConfigs.push(cfg);
          },
          renderButton: () => undefined,
        },
      },
    };
    TestBed.configureTestingModule({ providers: [GoogleAuthService] });
    service = TestBed.inject(GoogleAuthService);
  });

  afterEach(() => {
    delete (window as unknown as { google?: unknown }).google;
  });

  function host(): HTMLElement {
    const el = document.createElement('div');
    Object.defineProperty(el, 'clientWidth', { value: 320 });
    return el;
  }

  it('default mode throws on a different nonce after the first initialization (login/signup guard)', async () => {
    await service.renderWebButton(host(), 'client-1', 'nonce-A', () => undefined);
    await expect(service.renderWebButton(host(), 'client-1', 'nonce-B', () => undefined))
      .rejects.toThrow(/refresh the page/i);
    expect(initConfigs).toHaveLength(1); // not re-initialized
  });

  it('reinitialize mode re-initializes GIS with a fresh nonce without throwing', async () => {
    await service.renderWebButton(host(), 'client-1', 'nonce-A', () => undefined, { reinitialize: true });
    await service.renderWebButton(host(), 'client-1', 'nonce-B', () => undefined, { reinitialize: true });
    expect(initConfigs).toHaveLength(2);
    expect(initConfigs[1].nonce).toBe('nonce-B');
  });

  it('only the active attempt receives its credential callback (isolation)', async () => {
    const firstCb = vi.fn();
    const secondCb = vi.fn();
    await service.renderWebButton(host(), 'client-1', 'nonce-A', firstCb, { reinitialize: true });
    await service.renderWebButton(host(), 'client-1', 'nonce-B', secondCb, { reinitialize: true });
    // GIS delivers a credential; the latest initialize's callback is the one GIS would call.
    initConfigs[1].callback({ credential: 'token-B' });
    expect(secondCb).toHaveBeenCalledWith('token-B');
    expect(firstCb).not.toHaveBeenCalled();
    // A late delivery to the SUPERSEDED attempt's callback is dropped (attempt no longer active).
    initConfigs[0].callback({ credential: 'token-A' });
    expect(firstCb).not.toHaveBeenCalled();
  });

  it('resetWebInitialization supersedes the in-flight attempt and allows a clean re-init', async () => {
    const staleCb = vi.fn();
    await service.renderWebButton(host(), 'client-1', 'nonce-A', staleCb, { reinitialize: true });
    service.resetWebInitialization();
    // The stale attempt's callback is now inert.
    initConfigs[0].callback({ credential: 'token-A' });
    expect(staleCb).not.toHaveBeenCalled();
    // A fresh render re-initializes cleanly.
    const freshCb = vi.fn();
    await service.renderWebButton(host(), 'client-1', 'nonce-C', freshCb, { reinitialize: true });
    expect(initConfigs).toHaveLength(2);
    initConfigs[1].callback({ credential: 'token-C' });
    expect(freshCb).toHaveBeenCalledWith('token-C');
  });

  it('a credential with no token does not invoke the callback', async () => {
    const cb = vi.fn();
    await service.renderWebButton(host(), 'client-1', 'nonce-A', cb, { reinitialize: true });
    initConfigs[0].callback({});
    expect(cb).not.toHaveBeenCalled();
  });
});
