/**
 * @file db.js
 * @description Neon Postgres connection pool, table setup and first-run seeding.
 */
import pg from 'pg';
import { SEED_PRODUCTS } from './seed-data.js';
import { splitFullName } from './validation.js';

const { Pool } = pg;

export const isDbConfigured = Boolean(process.env.DATABASE_URL);

/**
 * Neon's copied string ends with ?sslmode=require&channel_binding=require.
 * We drop those flags and turn on full TLS certificate checking ourselves,
 * which is what pg does anyway and keeps its "SSL modes" warning out of the logs.
 */
function connectionString() {
  const url = new URL(process.env.DATABASE_URL);
  url.searchParams.delete('sslmode');
  url.searchParams.delete('channel_binding');
  return url.toString();
}

export const pool = isDbConfigured
  ? new Pool({
      connectionString: connectionString(),
      ssl: { rejectUnauthorized: true },
      max: 5,
      idleTimeoutMillis: 10_000,
      keepAlive: true,
    })
  : null;

// Neon closes idle connections when it suspends, so log pool errors instead of crashing the API.
pool?.on('error', (err) => console.error('[db] idle connection dropped:', err.message));

/** Runs a parameterized query against Neon. */
export function query(text, params = []) {
  if (!pool) {
    const err = new Error('DATABASE_URL is not set. Paste your Neon connection string into server/.env.');
    err.status = 503;
    throw err;
  }
  return pool.query(text, params);
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS users (
    id            SERIAL PRIMARY KEY,
    full_name     TEXT NOT NULL,
    email         TEXT NOT NULL UNIQUE,
    phone         TEXT NOT NULL,
    avatar        TEXT,
    password_hash TEXT NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS products (
    id            SERIAL PRIMARY KEY,
    slug          TEXT NOT NULL UNIQUE,
    name          TEXT NOT NULL,
    tagline       TEXT NOT NULL,
    description   TEXT NOT NULL,
    flavor_notes  TEXT NOT NULL,
    category      TEXT NOT NULL,
    price         NUMERIC(10, 2) NOT NULL CHECK (price >= 0),
    rating        NUMERIC(3, 2) NOT NULL DEFAULT 5,
    reviews_count INT NOT NULL DEFAULT 0,
    calories      INT NOT NULL DEFAULT 0,
    allergens     TEXT[] NOT NULL DEFAULT '{}',
    badge         TEXT,
    image_url     TEXT NOT NULL,
    is_available  BOOLEAN NOT NULL DEFAULT true,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS cart_items (
    id         SERIAL PRIMARY KEY,
    user_id    INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    product_id INT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    quantity   INT NOT NULL CHECK (quantity > 0),
    added_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (user_id, product_id)
  );

  CREATE TABLE IF NOT EXISTS contact_messages (
    id         SERIAL PRIMARY KEY,
    user_id    INT REFERENCES users(id) ON DELETE SET NULL,
    name       TEXT NOT NULL,
    email      TEXT NOT NULL,
    subject    TEXT NOT NULL,
    message    TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  -- Records one-time data migrations so they never run twice.
  CREATE TABLE IF NOT EXISTS app_meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  -- v0.6.1: home-screen collections (best sellers, new, promos) and cart checkboxes.
  ALTER TABLE products   ADD COLUMN IF NOT EXISTS is_best_seller BOOLEAN NOT NULL DEFAULT false;
  ALTER TABLE products   ADD COLUMN IF NOT EXISTS is_new         BOOLEAN NOT NULL DEFAULT false;
  ALTER TABLE products   ADD COLUMN IF NOT EXISTS sale_price     NUMERIC(10, 2) CHECK (sale_price >= 0);
  ALTER TABLE cart_items ADD COLUMN IF NOT EXISTS selected       BOOLEAN NOT NULL DEFAULT true;

  -- v0.7: mix-and-match cookie boxes (4, 6 or 12 cookies) in the cart.
  CREATE TABLE IF NOT EXISTS cart_boxes (
    id       SERIAL PRIMARY KEY,
    user_id  INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    size     INT NOT NULL CHECK (size IN (4, 6, 12)),
    quantity INT NOT NULL DEFAULT 1 CHECK (quantity > 0),
    selected BOOLEAN NOT NULL DEFAULT true,
    added_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS cart_box_items (
    box_id     INT NOT NULL REFERENCES cart_boxes(id) ON DELETE CASCADE,
    slot       INT NOT NULL CHECK (slot >= 0),
    product_id INT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    PRIMARY KEY (box_id, slot)
  );

  ALTER TABLE users ADD COLUMN IF NOT EXISTS first_name TEXT;
  ALTER TABLE users ADD COLUMN IF NOT EXISTS last_name TEXT;
`;

/** Creates the tables (if missing) and loads the Cookie Fluffs menu. */
export async function initDb() {
  if (!pool) return { ready: false, seeded: 0 };

  await query(SCHEMA);
  await splitNamesOnce();

  let seeded = 0;
  for (const p of SEED_PRODUCTS) {
    const res = await query(
      `INSERT INTO products
         (slug, name, tagline, description, flavor_notes, category, price,
          rating, reviews_count, calories, allergens, badge, image_url,
          is_best_seller, is_new, sale_price)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
       ON CONFLICT (slug) DO NOTHING`,
      [
        p.slug, p.name, p.tagline, p.description, p.flavorNotes, p.category, p.price,
        p.rating, p.reviewsCount, p.calories, p.allergens, p.badge, p.imageUrl,
        Boolean(p.isBestSeller), Boolean(p.isNew), p.salePrice ?? null,
      ],
    );
    seeded += res.rowCount;
  }

  await applyCollectionsOnce();
  await retireOldMenuOnce();
  return { ready: true, seeded };
}

/** Backfills split name fields once while preserving each user's display name. */
async function splitNamesOnce() {
  const done = await query(`SELECT 1 FROM app_meta WHERE key = 'names_v1'`);
  if (done.rowCount) return;
  const { rows } = await query('SELECT id, full_name FROM users WHERE first_name IS NULL');
  for (const row of rows) {
    const { firstName, lastName } = splitFullName(row.full_name);
    await query('UPDATE users SET first_name = $2, last_name = $3 WHERE id = $1', [row.id, firstName, lastName]);
  }
  await query(`INSERT INTO app_meta (key, value) VALUES ('names_v1', now()::text)`);
}

/**
 * v0.7 menu: the 18 cookies with real product photos replaced the first 12-cookie menu.
 * Old cookies are hidden (is_available = false) rather than deleted, and removed from carts.
 */
async function retireOldMenuOnce() {
  const done = await query(`SELECT 1 FROM app_meta WHERE key = 'menu_v2'`);
  if (done.rowCount) return;
  const slugs = SEED_PRODUCTS.map((p) => p.slug);
  await query('UPDATE products SET is_available = false WHERE NOT (slug = ANY($1))', [slugs]);
  await query('DELETE FROM cart_items WHERE product_id IN (SELECT id FROM products WHERE NOT is_available)');
  await query(`INSERT INTO app_meta (key, value) VALUES ('menu_v2', now()::text)`);
}

/**
 * Copies the best-seller / new / promo flags from seed-data.js onto products that
 * existed before those columns did. Runs once (recorded in app_meta), so later
 * edits, e.g. from a future admin panel, are never overwritten.
 */
async function applyCollectionsOnce() {
  const done = await query(`SELECT 1 FROM app_meta WHERE key = 'collections_v1'`);
  if (done.rowCount) return;
  for (const p of SEED_PRODUCTS) {
    await query('UPDATE products SET is_best_seller = $2, is_new = $3, sale_price = $4 WHERE slug = $1', [
      p.slug,
      Boolean(p.isBestSeller),
      Boolean(p.isNew),
      p.salePrice ?? null,
    ]);
  }
  await query(`INSERT INTO app_meta (key, value) VALUES ('collections_v1', now()::text)`);
}
