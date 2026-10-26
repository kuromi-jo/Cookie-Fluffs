/**
 * @file api-error.ts
 * @description Converts API failures into safe user messages and field errors.
 */
import { HttpErrorResponse } from '@angular/common/http';

/** Turns any HTTP failure into a short message we can show the user. */
export function apiErrorMessage(err: unknown): string {
  if (err instanceof HttpErrorResponse) {
    if (err.status === 0 || err.status === 504) {
      return 'We could not reach Cookie Fluffs. Check your connection and try again.';
    }
    const body = err.error;
    if (
      (err.status === 400 || err.status === 401 || err.status === 409 || err.status === 429) &&
      body &&
      typeof body === 'object' &&
      typeof body.message === 'string'
    ) {
      return body.message;
    }
    if (err.status === 503) return 'Cookie Fluffs is having trouble right now. Please try again in a moment.';
  }
  return 'Something went wrong on our side. Please try again.';
}

/** Returns field-specific validation messages from signup and profile failures. */
export function apiFieldErrors(err: unknown): Record<string, string> {
  if (!(err instanceof HttpErrorResponse) || (err.status !== 400 && err.status !== 409)) return {};
  const body = err.error;
  if (!body || typeof body !== 'object' || !('errors' in body)) return {};
  const errors = body.errors;
  if (!errors || typeof errors !== 'object') return {};

  return Object.fromEntries(
    Object.entries(errors).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  );
}
