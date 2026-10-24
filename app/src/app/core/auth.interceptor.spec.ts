/**
 * @file auth.interceptor.spec.ts
 * @description Verifies that the ngrok warning bypass stays scoped to the configured sandbox API.
 */
import { sandboxTransportHeaders } from './auth.interceptor';

describe('sandboxTransportHeaders', () => {
  const apiUrl = 'https://cookie-fluffs.ngrok-free.dev/api';

  it('adds the warning bypass to configured ngrok API requests', () => {
    expect(sandboxTransportHeaders(apiUrl, `${apiUrl}/products`)).toEqual({
      'ngrok-skip-browser-warning': 'true',
    });
  });

  it('does not add the header to unrelated hosts or similar paths', () => {
    expect(sandboxTransportHeaders(apiUrl, 'https://api.paymongo.com/v1/payment_methods')).toEqual({});
    expect(sandboxTransportHeaders(apiUrl, 'https://cookie-fluffs.ngrok-free.dev/api-copy/products')).toEqual({});
    expect(sandboxTransportHeaders(apiUrl, 'https://other.ngrok-free.dev/api/products')).toEqual({});
  });

  it('does not affect relative development or non-ngrok APIs', () => {
    expect(sandboxTransportHeaders('/api', '/api/products')).toEqual({});
    expect(sandboxTransportHeaders('https://api.cookiefluffs.example/api', 'https://api.cookiefluffs.example/api/products'))
      .toEqual({});
  });
});
