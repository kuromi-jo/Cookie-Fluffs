/**
 * @file auth.service.ts
 * @description Login state for the whole app. The token is kept in localStorage
 * so the user stays logged in after a refresh.
 */
import { Injectable, computed, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { environment } from '../../environments/environment';
import { AuthResponse, User } from './models';

const TOKEN_KEY = 'cf.token';
const USER_KEY = 'cf.user';

export interface SignupData {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  password: string;
}

export interface PasswordRecoveryConfig {
  enabled: boolean;
}

export interface GoogleAuthConfig {
  enabled: boolean;
  webClientId?: string;
}

export interface GoogleAuthPending {
  kind: 'signup_required' | 'link_required';
  selector: string;
  challenge: string;
  message?: string;
  profile?: { email: string; firstName: string; lastName: string };
}

export type GoogleAuthIntent = 'login' | 'signup';

export interface AccountStatus {
  hasPassword: boolean;
  google: { linked: boolean };
}

@Injectable({ providedIn: 'root' })
export class AuthService {
  private http = inject(HttpClient);
  private base = `${environment.apiUrl}/auth`;

  readonly token = signal<string | null>(read(TOKEN_KEY));
  readonly user = signal<User | null>(readJson<User>(USER_KEY));
  readonly isLoggedIn = computed(() => !!this.token() && !!this.user());

  /** First name for friendly greetings, e.g. "Hi, Jonie". */
  readonly firstName = computed(() => this.user()?.firstName ?? this.user()?.fullName.split(' ')[0] ?? '');

  async login(email: string, password: string): Promise<User> {
    const res = await firstValueFrom(this.http.post<AuthResponse>(`${this.base}/login`, { email, password }));
    this.setSession(res);
    return res.user;
  }

  async signup(data: SignupData): Promise<User> {
    const res = await firstValueFrom(this.http.post<AuthResponse>(`${this.base}/signup`, data));
    this.setSession(res);
    return res.user;
  }

  /** Re-reads the profile from the server (used on app start to validate the saved token). */
  async refreshProfile(): Promise<void> {
    if (!this.token()) return;
    const user = await firstValueFrom(this.http.get<User>(`${this.base}/me`));
    this.setUser(user);
  }

  async updateProfile(
    changes: Partial<Pick<User, 'firstName' | 'lastName' | 'phone' | 'avatar' | 'gender' | 'dateOfBirth'>>,
  ): Promise<User> {
    const user = await firstValueFrom(this.http.put<User>(`${this.base}/me`, changes));
    this.setUser(user);
    return user;
  }

  /** Changes the password and atomically replaces this device's revoked session token. */
  async changePassword(currentPassword: string, newPassword: string): Promise<User> {
    const response = await firstValueFrom(this.http.post<AuthResponse>(`${this.base}/change-password`, {
      currentPassword,
      newPassword,
    }));
    this.setSession(response);
    return response.user;
  }

  async passwordRecoveryConfig(): Promise<PasswordRecoveryConfig> {
    return firstValueFrom(this.http.get<PasswordRecoveryConfig>(`${this.base}/recovery-config`));
  }

  async googleAuthConfig(): Promise<GoogleAuthConfig> {
    return firstValueFrom(this.http.get<GoogleAuthConfig>(`${this.base}/google-config`));
  }

  /** Reads which sign-in methods the authenticated account has (booleans only). */
  async accountStatus(): Promise<AccountStatus> {
    return firstValueFrom(this.http.get<AccountStatus>(`${this.base}/account-status`));
  }

  /** Applies a verified phone change (requires a verified change_phone challenge handle). */
  async changePhone(challengeId: string, newPhone: string): Promise<User> {
    const response = await firstValueFrom(
      this.http.post<{ user: User }>(`${this.base}/change-phone`, { challengeId, newPhone }),
    );
    this.setUser(response.user);
    return response.user;
  }

  /** Step-up reauthentication with the current password; returns an opaque single-use proof id. */
  async reauthPassword(password: string): Promise<string> {
    const response = await firstValueFrom(
      this.http.post<{ reauthId: string }>(`${this.base}/reauth`, { method: 'password', password }),
    );
    return response.reauthId;
  }

  /**
   * Step-up reauthentication with a fresh Google token; returns an opaque single-use proof id
   * bound to the given operation (default change_email for backward compatibility).
   */
  async reauthGoogle(
    selector: string,
    nonce: string,
    idToken: string,
    operation: 'change_email' | 'set_password' = 'change_email',
  ): Promise<string> {
    const response = await firstValueFrom(
      this.http.post<{ reauthId: string }>(`${this.base}/reauth`, {
        method: 'google', selector, nonce, idToken, operation,
      }),
    );
    return response.reauthId;
  }

  /**
   * Sets a first password for a Google-only account. Requires a Google reauth proof and a verified
   * set_password challenge. The server rotates auth_version and returns a fresh token, so this
   * device stays signed in while other sessions are invalidated.
   */
  async setPassword(reauthId: string, challengeId: string, newPassword: string): Promise<User> {
    const response = await firstValueFrom(
      this.http.post<AuthResponse>(`${this.base}/set-password`, { reauthId, challengeId, newPassword }),
    );
    this.setSession(response);
    return response.user;
  }

  /**
   * Applies a verified email change. Requires a reauth proof and a verified change_email
   * challenge for the new address. The server rotates auth_version and returns a fresh token,
   * so this device stays signed in while other sessions are invalidated.
   */
  async changeEmail(reauthId: string, challengeId: string, newEmail: string): Promise<User> {
    const response = await firstValueFrom(
      this.http.post<AuthResponse>(`${this.base}/change-email`, { reauthId, challengeId, newEmail }),
    );
    this.setSession(response);
    return response.user;
  }

  async googleNonce(intent: GoogleAuthIntent): Promise<{ selector: string; nonce: string }> {
    return firstValueFrom(this.http.post<{ selector: string; nonce: string }>(`${this.base}/google/nonce`, { intent }));
  }

  async authenticateWithGoogle(idToken: string, selector: string, nonce: string): Promise<User> {
    const response = await firstValueFrom(this.http.post<AuthResponse>(`${this.base}/google/authenticate`, {
      idToken,
      selector,
      nonce,
    }));
    this.setSession(response);
    return response.user;
  }

  async completeGoogleSignup(
    selector: string,
    challenge: string,
    firstName: string,
    lastName: string,
    phone: string,
    acceptedTerms: boolean,
  ): Promise<User> {
    const response = await firstValueFrom(this.http.post<AuthResponse>(`${this.base}/google/signup`, {
      selector,
      challenge,
      firstName,
      lastName,
      phone,
      acceptedTerms,
    }));
    this.setSession(response);
    return response.user;
  }

  async linkGoogleAccount(selector: string, challenge: string, password: string): Promise<User> {
    const response = await firstValueFrom(this.http.post<AuthResponse>(`${this.base}/google/link`, {
      selector,
      challenge,
      password,
    }));
    this.setSession(response);
    return response.user;
  }

  async requestPasswordReset(email: string): Promise<string> {
    const response = await firstValueFrom(this.http.post<{ message: string }>(`${this.base}/forgot-password`, { email }));
    return response.message;
  }

  async resetPassword(selector: string, token: string, newPassword: string): Promise<string> {
    const response = await firstValueFrom(this.http.post<{ message: string }>(`${this.base}/reset-password`, {
      selector,
      token,
      newPassword,
    }));
    return response.message;
  }

  logout(): void {
    this.token.set(null);
    this.user.set(null);
    try {
      localStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem(USER_KEY);
    } catch {
      /* storage unavailable */
    }
  }

  private setSession({ token, user }: AuthResponse): void {
    this.token.set(token);
    write(TOKEN_KEY, token);
    this.setUser(user);
  }

  private setUser(user: User): void {
    this.user.set(user);
    write(USER_KEY, JSON.stringify(user));
  }
}

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function readJson<T>(key: string): T | null {
  const raw = read(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage unavailable or full; session still works until refresh */
  }
}
