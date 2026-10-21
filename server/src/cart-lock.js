/**
 * @file cart-lock.js
 * @description Shared per-customer PostgreSQL lock for cart writes and checkout.
 */

/** Serializes one customer's cart mutations and checkout across API processes. */
export function lockUserCart(client, userId) {
  return client.query('SELECT pg_advisory_xact_lock($1::bigint)', [userId]);
}
