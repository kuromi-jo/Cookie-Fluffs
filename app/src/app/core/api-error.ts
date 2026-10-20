import { HttpErrorResponse } from '@angular/common/http';

/** Turns any HTTP failure into a short message we can show the user. */
export function apiErrorMessage(err: unknown): string {
  if (err instanceof HttpErrorResponse) {
    if (err.status === 0 || err.status === 504) {
      return 'Cannot reach the Cookie Fluffs server. Is it running?';
    }
    const body = err.error;
    if (body && typeof body === 'object' && typeof body.message === 'string') return body.message;
    if (err.status === 503) return 'The database is not connected yet. Check server/.env.';
    return `Request failed (${err.status}). Please try again.`;
  }
  return 'Something went wrong. Please try again.';
}
