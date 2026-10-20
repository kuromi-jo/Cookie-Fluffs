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
  fullName: string;
  email: string;
  phone: string;
  password: string;
  avatar: string | null;
}

@Injectable({ providedIn: 'root' })
export class AuthService {
  private http = inject(HttpClient);
  private base = `${environment.apiUrl}/auth`;

  readonly token = signal<string | null>(read(TOKEN_KEY));
  readonly user = signal<User | null>(readJson<User>(USER_KEY));
  readonly isLoggedIn = computed(() => !!this.token() && !!this.user());

  /** First name for friendly greetings, e.g. "Hi, Jonie". */
  readonly firstName = computed(() => this.user()?.fullName.split(' ')[0] ?? '');

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

  async updateProfile(changes: Partial<Pick<User, 'fullName' | 'phone' | 'avatar'>>): Promise<User> {
    const user = await firstValueFrom(this.http.put<User>(`${this.base}/me`, changes));
    this.setUser(user);
    return user;
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
