/**
 * @file auth.interceptor.ts
 * @description Adds authentication and sandbox transport headers to Cookie Fluffs API requests.
 */
import { HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { AuthService } from './auth.service';
import { environment } from '../../environments/environment';

const NGROK_WARNING_HEADER = 'ngrok-skip-browser-warning';

/** Returns the ngrok browser-warning bypass only for the configured ngrok API. */
export function sandboxTransportHeaders(apiUrl: string, requestUrl: string): Record<string, string> {
  try {
    const api = new URL(apiUrl);
    const request = new URL(requestUrl);
    const apiPath = api.pathname.replace(/\/$/, '');
    const isConfiguredApi = request.origin === api.origin
      && (request.pathname === apiPath || request.pathname.startsWith(`${apiPath}/`));

    return isConfiguredApi && api.protocol === 'https:' && api.hostname.endsWith('.ngrok-free.dev')
      ? { [NGROK_WARNING_HEADER]: 'true' }
      : {};
  } catch {
    return {};
  }
}

/** Adds the API transport header and the bearer token when logged in. */
export const authInterceptor: HttpInterceptorFn = (req, next) => {
  const token = inject(AuthService).token();
  const setHeaders = sandboxTransportHeaders(environment.apiUrl, req.url);
  if (token) setHeaders['Authorization'] = `Bearer ${token}`;

  return next(Object.keys(setHeaders).length ? req.clone({ setHeaders }) : req);
};
