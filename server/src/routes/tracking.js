/**
 * @file tracking.js
 * @description GET /api/orders/:id/tracking: map points for the order tracker. The kitchen location is
 * fixed; the delivery address is geocoded with OpenStreetMap Nominatim (free, no key) and cached in memory.
 * The map itself is drawn in the app from OpenStreetMap tiles.
 */
import { Router } from 'express';
import { query } from '../db.js';
import { requireAuth } from '../auth.js';

const router = Router();

/** Cookie Fluffs kitchen (Cubao, Quezon City). */
export const KITCHEN = { lat: 14.6227, lng: 121.0532, label: 'Cookie Fluffs kitchen, Cubao' };

const NOMINATIM = 'https://nominatim.openstreetmap.org/search';
const cache = new Map(); // address text -> { lat, lng } | null
let lastLookup = 0;

async function geocode(text) {
  if (cache.has(text)) return cache.get(text);
  // Nominatim usage policy: at most one request per second, with an identifying User-Agent.
  const wait = lastLookup + 1100 - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastLookup = Date.now();
  try {
    const url = `${NOMINATIM}?format=json&limit=1&countrycodes=ph&q=${encodeURIComponent(text)}`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'CookieFluffs-SchoolProject/1.0 (order tracker)', 'Accept-Language': 'en' },
      signal: AbortSignal.timeout(6000),
    });
    const [hit] = res.ok ? await res.json() : [];
    const point = hit ? { lat: Number(hit.lat), lng: Number(hit.lon) } : null;
    cache.set(text, point);
    return point;
  } catch {
    return null; // network hiccup: try again on the next request
  }
}

/** Tries the most specific address first, then wider areas, so the pin lands as close as possible. */
async function locate(o) {
  const tries = [
    [o.barangay, o.city, o.province],
    [o.city, o.province],
  ].map((parts) => parts.filter(Boolean).join(', ') + ', Philippines');
  for (const text of tries) {
    const point = await geocode(text);
    if (point) return point;
  }
  return null;
}

// GET /api/orders/:id/tracking
router.get('/:id/tracking', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT fulfillment_method AS fulfillment, order_status AS status, barangay, city, province
       FROM orders WHERE public_id::text = $1 AND user_id = $2`,
      [String(req.params.id), req.userId],
    );
    if (!rows.length) return res.status(404).json({ message: 'We couldn’t find this order for your account.' });
    const o = rows[0];
    const destination =
      o.fulfillment === 'delivery' && o.city
        ? await locate(o).then((p) => (p ? { ...p, label: [o.barangay, o.city].filter(Boolean).join(', ') } : null))
        : null;
    res.json({ kitchen: KITCHEN, destination, fulfillment: o.fulfillment, status: o.status });
  } catch (err) {
    next(err);
  }
});

export default router;
