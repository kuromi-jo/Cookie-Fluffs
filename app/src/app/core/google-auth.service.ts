/**
 * @file google-auth.service.ts
 * @description Transient web and Android Google credential collection for server verification.
 */
import { Injectable } from '@angular/core';
import { Capacitor, registerPlugin } from '@capacitor/core';

interface NativeGoogleAuthPlugin {
  signIn(options: { serverClientId: string; nonce: string }): Promise<{ idToken: string }>;
}

interface GoogleCredentialResponse {
  credential?: string;
}

interface GoogleIdentityApi {
  accounts: {
    id: {
      initialize(options: { client_id: string; nonce: string; callback: (response: GoogleCredentialResponse) => void }): void;
      renderButton(element: HTMLElement, options: Record<string, string | number>): void;
    };
  };
}

declare global {
  interface Window {
    google?: GoogleIdentityApi;
  }
}

const NativeGoogleAuth = registerPlugin<NativeGoogleAuthPlugin>('GoogleAuth');
const GIS_SCRIPT_ID = 'cookie-fluffs-google-identity';
const GOOGLE_RESTART_STATE = 'cookieFluffsGoogleRestart';
/** Session flag read by the app shell: the next page load is a Google re-init, so skip the splash. */
export const SKIP_SPLASH_KEY = 'cf.skipSplash';
const STRICT_REFERRER_POLICY = 'strict-origin-when-cross-origin';
const LOCALHOST_REFERRER_POLICY = 'no-referrer-when-downgrade';

export function googleReferrerPolicy(location: Pick<Location, 'hostname' | 'protocol' | 'pathname'>): ReferrerPolicy {
  const localHttp = location.protocol === 'http:' && location.hostname === 'localhost';
  const sensitiveRoute = location.pathname.startsWith('/reset-password');
  return localHttp && !sensitiveRoute ? LOCALHOST_REFERRER_POLICY : STRICT_REFERRER_POLICY;
}

@Injectable({ providedIn: 'root' })
export class GoogleAuthService {
  readonly isNativeAndroid = Capacitor.getPlatform() === 'android';
  private libraryPromise: Promise<void> | null = null;
  private initializationPromise: Promise<void> | null = null;
  private initializedClientId: string | null = null;
  private initializedNonce: string | null = null;
  private originalReferrerPolicy: string | null = null;
  // Monotonic attempt id. Each renderWebButton call claims the next id; GIS credential callbacks
  // only fire the caller's callback when their attempt is still the active one. This isolates a
  // superseded/canceled attempt's callback from a newer attempt (and from login/signup).
  private attemptSeq = 0;
  private activeAttempt = 0;

  async nativeIdToken(serverClientId: string, nonce: string): Promise<string> {
    const result = await NativeGoogleAuth.signIn({ serverClientId, nonce });
    if (!result.idToken) throw new Error('Google sign-in did not return a credential.');
    return result.idToken;
  }

  /**
   * Renders the GIS button into `element` and routes a returned credential to `callback`.
   *
   * By default (login/signup) GIS is initialized exactly once per page load; a later call with a
   * different nonce throws, preserving the existing one-attempt-per-page protection.
   *
   * With `{ reinitialize: true }` (step-up reauthentication) a fresh, server-issued, single-use
   * nonce is allowed to re-initialize GIS without a page reload. Each call claims a new attempt
   * id and binds its callback to that id, so a credential delivered for a canceled/superseded
   * attempt is dropped and can never authenticate a newer attempt or a login/signup flow.
   */
  async renderWebButton(
    element: HTMLElement,
    serverClientId: string,
    nonce: string,
    callback: (idToken: string) => void,
    { reinitialize = false }: { reinitialize?: boolean } = {},
  ): Promise<void> {
    await this.loadWebLibrary();

    const sameConfig = this.initializedClientId === serverClientId && this.initializedNonce === nonce;
    if (this.initializationPromise && !sameConfig && !reinitialize) {
      // Default (login/signup): do not silently switch nonce; force a clean page.
      throw new Error('Refresh the page to start a fresh Google sign-in.');
    }

    // Claim this attempt. Only the active attempt's callback may fire.
    const attempt = ++this.attemptSeq;
    this.activeAttempt = attempt;

    const needsInit = !this.initializationPromise || (reinitialize && !sameConfig);
    if (needsInit) {
      this.initializedClientId = serverClientId;
      this.initializedNonce = nonce;
      this.initializationPromise = Promise.resolve().then(() => {
        window.google!.accounts.id.initialize({
          client_id: serverClientId,
          nonce,
          callback: (response) => {
            // Isolation: ignore a credential unless THIS attempt is still the active one.
            if (this.activeAttempt !== attempt) return;
            if (response.credential) callback(response.credential);
          },
        });
      });
    }
    await this.initializationPromise;
    element.replaceChildren();
    window.google!.accounts.id.renderButton(element, {
      type: 'standard',
      theme: 'outline',
      size: 'large',
      shape: 'pill',
      text: 'continue_with',
      width: Math.min(360, Math.max(240, element.clientWidth || 320)),
    });
  }

  /**
   * Clears cached GIS initialization so the next reauth renderWebButton re-initializes cleanly
   * with a fresh nonce, and supersedes any in-flight attempt (its callback becomes inert). Scoped
   * to step-up reauthentication; login/signup never call this, so their one-per-page flow is
   * unchanged.
   */
  resetWebInitialization(): void {
    this.initializationPromise = null;
    this.initializedClientId = null;
    this.initializedNonce = null;
    // Advance the active attempt so any pending (canceled) attempt's callback is ignored.
    this.activeAttempt = ++this.attemptSeq;
  }

  prepareWebPage(): void {
    if (this.isNativeAndroid || this.originalReferrerPolicy !== null) return;
    const meta = document.querySelector<HTMLMetaElement>('meta[name="referrer"]');
    if (!meta) return;
    this.originalReferrerPolicy = meta.content;
    meta.content = googleReferrerPolicy(window.location);
  }

  restoreWebPage(): void {
    if (this.originalReferrerPolicy === null) return;
    const meta = document.querySelector<HTMLMetaElement>('meta[name="referrer"]');
    if (meta) meta.content = this.originalReferrerPolicy;
    this.originalReferrerPolicy = null;
  }

  hasInitializedWebAttempt(): boolean {
    return this.initializationPromise !== null;
  }

  restartWebPage(notice: 'link' | 'retry' | null = 'retry'): void {
    const state = history.state && typeof history.state === 'object' ? history.state : {};
    const next = { ...state };
    if (notice) next[GOOGLE_RESTART_STATE] = notice;
    else delete next[GOOGLE_RESTART_STATE];
    history.replaceState(next, document.title, window.location.href);
    // This is a technical reload (fresh Google nonce), not an app launch: skip the splash once.
    try {
      sessionStorage.setItem(SKIP_SPLASH_KEY, '1');
    } catch {
      /* storage blocked: the splash simply shows */
    }
    window.location.reload();
  }

  consumeRestartNotice(): 'link' | 'retry' | null {
    const notice = history.state?.[GOOGLE_RESTART_STATE];
    if (notice !== 'link' && notice !== 'retry') return null;
    const next = { ...history.state };
    delete next[GOOGLE_RESTART_STATE];
    history.replaceState(next, document.title, window.location.href);
    return notice;
  }

  private async loadWebLibrary(): Promise<void> {
    if (window.google?.accounts.id) return;
    if (this.libraryPromise) return this.libraryPromise;
    this.libraryPromise = new Promise<void>((resolve, reject) => {
      const script = document.createElement('script');
      script.id = GIS_SCRIPT_ID;
      script.src = 'https://accounts.google.com/gsi/client';
      script.async = true;
      script.defer = true;
      script.referrerPolicy = googleReferrerPolicy(window.location);
      script.addEventListener('load', () => resolve(), { once: true });
      script.addEventListener('error', () => reject(new Error('Google sign-in could not load.')), { once: true });
      document.head.appendChild(script);
    });
    try {
      await this.libraryPromise;
    } catch (error) {
      this.libraryPromise = null;
      throw error;
    }
  }
}
