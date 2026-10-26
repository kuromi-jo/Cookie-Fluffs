/**
 * @file verification.service.ts
 * @description Client for the identity-verification challenge endpoints. Raw codes are never
 * returned by the API; this service only starts a challenge (which triggers out-of-band
 * delivery server-side) and submits the entered code for verification.
 */
import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { environment } from '../../environments/environment';

export type VerificationOperation =
  | 'change_phone'
  | 'change_email'
  | 'set_password'
  | 'change_password';

export interface VerificationStart {
  challengeId: string | null;
  operation: VerificationOperation;
  channel: string;
  maskedDestination: string | null;
  expiresInMinutes: number;
  delivered: boolean;
  /** True when delivery was attempted but failed (never means "sent"). */
  deliveryFailed?: boolean;
  /** True when a confirmed-rejected send was voided server-side, so an immediate retry is safe. */
  canRetry?: boolean;
  deliveryEnabled: boolean;
}

export interface VerificationResult {
  verified: boolean;
  challengeId: string;
  operation: VerificationOperation;
}

@Injectable({ providedIn: 'root' })
export class VerificationService {
  private http = inject(HttpClient);
  private base = `${environment.apiUrl}/verification`;

  /** Starts (or resends) a challenge. The server delivers the code out-of-band when enabled. */
  async start(operation: VerificationOperation, target: string | null = null): Promise<VerificationStart> {
    return firstValueFrom(this.http.post<VerificationStart>(`${this.base}/start`, { operation, target }));
  }

  /** Submits the entered code. Returns a verified authorization handle on success. */
  async verify(
    challengeId: string,
    operation: VerificationOperation,
    code: string,
    target: string | null = null,
  ): Promise<VerificationResult> {
    return firstValueFrom(
      this.http.post<VerificationResult>(`${this.base}/verify`, { challengeId, operation, code, target }),
    );
  }

  /**
   * Issues a purpose-bound Google step-up nonce for the authenticated customer (reauthentication,
   * NOT login/signup). Only available to accounts with a linked Google identity.
   */
  async googleReauthNonce(): Promise<{ selector: string; nonce: string }> {
    return firstValueFrom(
      this.http.post<{ selector: string; nonce: string }>(`${this.base}/google/nonce`, {}),
    );
  }
}
