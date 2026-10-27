/**
 * @file db.js
 * @description Neon Postgres connection pool, table setup and first-run seeding.
 */
import crypto from 'node:crypto';
import pg from 'pg';
import { SEED_PRODUCTS } from './seed-data.js';
import { splitFullName } from './validation.js';

const { Pool } = pg;

export const isDbConfigured = Boolean(process.env.DATABASE_URL);

/** Builds strict remote TLS options while allowing isolated loopback test databases. */
function connectionOptions() {
  const url = new URL(process.env.DATABASE_URL);
  url.searchParams.delete('sslmode');
  url.searchParams.delete('channel_binding');
  const isLoopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  return {
    connectionString: url.toString(),
    ssl: isLoopback ? false : { rejectUnauthorized: true },
  };
}

export const pool = isDbConfigured
  ? new Pool({
      ...connectionOptions(),
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

const REQUIRED_SCHEMA_TABLES = Object.freeze([
  'users',
  'products',
  'cart_items',
  'orders',
  'payment_attempts',
  'customer_addresses',
  'user_favorites',
  'order_status_events',
  'order_refunds',
  'order_reorder_attempts',
  'auth_rate_limits',
  'account_security_events',
  'password_reset_tokens',
  'auth_recovery_rate_limits',
  'password_recovery_events',
  'user_google_identities',
  'google_auth_nonces',
  'google_auth_events',
  'notifications',
  'verification_challenges',
  'vouchers',
  'voucher_redemptions',
]);

const REQUIRED_MIGRATION_KEYS = Object.freeze([
  'orders_v1',
  'checkout_upgrade_v1',
  'card_demo_v1',
  'wallet_demo_v1',
  'order_agreement_v1',
  'address_book_v1',
  'favorites_preferences_v1',
  'order_image_snapshot_v1',
  'order_lifecycle_v1',
  'refund_management_v1',
  'reorder_v1',
  'auth_security_v1',
  'password_recovery_v1',
  'google_auth_v1',
  'google_auth_intent_v1',
  'notifications_v1',
  'profile_fields_v1',
  'verification_challenges_v1',
  'verification_verified_state_v1',
  'verification_auth_version_v1',
  'change_email_v1',
  'names_v1',
  'menu_v2',
  'collections_v1',
  'seasonal_menu_v1',
  'seasonal_menu_v2',
  'vouchers_v1',
]);

const MIGRATION_ADVISORY_LOCK = 1_126_663_214;

/** Returns only a safe readiness result; database errors never leave this boundary. */
export async function inspectSchemaReadiness(queryFn = query) {
  try {
    const tables = await queryFn(
      `SELECT item.name
       FROM unnest($1::text[]) AS item(name)
       WHERE to_regclass('public.' || item.name) IS NOT NULL`,
      [REQUIRED_SCHEMA_TABLES],
    );
    const migrations = await queryFn(
      `SELECT key FROM app_meta
       WHERE key = ANY($1::text[]) AND value <> 'pending'`,
      [REQUIRED_MIGRATION_KEYS],
    );
    return {
      ready: tables.rows.length === REQUIRED_SCHEMA_TABLES.length
        && migrations.rows.length === REQUIRED_MIGRATION_KEYS.length,
    };
  } catch {
    return { ready: false };
  }
}

/** Fails startup with a sanitized instruction when the expected schema is unavailable. */
export async function assertSchemaReady(queryFn = query) {
  const state = await inspectSchemaReadiness(queryFn);
  if (!state.ready) throw new Error('Database schema is not ready. Run npm run migrate before starting the API.');
  return state;
}

/** Runs additive migrations under a session advisory lock to prevent concurrent migration processes. */
export async function migrateWithLock(databasePool = pool, migrate = initDb) {
  if (!databasePool) throw new Error('Database is not configured.');
  const client = await databasePool.connect();
  let locked = false;
  try {
    const result = await client.query('SELECT pg_try_advisory_lock($1) AS locked', [MIGRATION_ADVISORY_LOCK]);
    locked = result.rows[0]?.locked === true;
    if (!locked) throw new Error('Another database migration is already running.');
    return await migrate();
  } finally {
    if (locked) await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_ADVISORY_LOCK]).catch(() => undefined);
    client.release();
  }
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
  ALTER TABLE products   ADD COLUMN IF NOT EXISTS season         TEXT;
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

const ORDER_SCHEMA = `
  -- P2a-1: immutable, server-priced cash orders.
  CREATE TABLE IF NOT EXISTS orders (
    id                     BIGSERIAL PRIMARY KEY,
    public_id              UUID NOT NULL UNIQUE,
    user_id                INT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    idempotency_key        UUID NOT NULL,
    request_fingerprint    CHAR(64) NOT NULL,
    fulfillment_method     TEXT NOT NULL CHECK (fulfillment_method IN ('delivery', 'pickup')),
    payment_method         TEXT NOT NULL CHECK (payment_method IN ('cash_on_delivery', 'cash_on_pickup')),
    payment_status         TEXT NOT NULL DEFAULT 'pending' CHECK (payment_status IN ('pending', 'paid', 'failed', 'refunded')),
    order_status           TEXT NOT NULL DEFAULT 'placed' CHECK (order_status IN ('placed', 'confirmed', 'preparing', 'ready', 'out_for_delivery', 'completed', 'cancelled')),
    scheduling_mode        TEXT NOT NULL DEFAULT 'asap' CHECK (scheduling_mode = 'asap'),
    contact_name           TEXT NOT NULL CHECK (char_length(contact_name) BETWEEN 2 AND 80),
    contact_phone          TEXT NOT NULL CHECK (char_length(contact_phone) BETWEEN 12 AND 13),
    address_line_1         TEXT,
    address_line_2         TEXT,
    barangay               TEXT,
    city                   TEXT,
    province               TEXT,
    postal_code            TEXT,
    notes                  TEXT NOT NULL DEFAULT '' CHECK (char_length(notes) <= 500),
    merchandise_subtotal   NUMERIC(12, 2) NOT NULL CHECK (merchandise_subtotal >= 0),
    promotion_discount     NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (promotion_discount >= 0),
    pack_discount          NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (pack_discount >= 0),
    discount_total         NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (discount_total = promotion_discount + pack_discount),
    delivery_fee           NUMERIC(12, 2) NOT NULL CHECK (delivery_fee >= 0),
    order_total            NUMERIC(12, 2) NOT NULL CHECK (order_total = merchandise_subtotal + delivery_fee),
    currency               CHAR(3) NOT NULL DEFAULT 'PHP' CHECK (currency = 'PHP'),
    created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (user_id, idempotency_key),
    CHECK (
      (fulfillment_method = 'delivery' AND payment_method = 'cash_on_delivery'
        AND address_line_1 IS NOT NULL AND barangay IS NOT NULL AND city IS NOT NULL
        AND province IS NOT NULL AND postal_code IS NOT NULL)
      OR
      (fulfillment_method = 'pickup' AND payment_method = 'cash_on_pickup'
        AND address_line_1 IS NULL AND address_line_2 IS NULL AND barangay IS NULL
        AND city IS NULL AND province IS NULL AND postal_code IS NULL AND delivery_fee = 0)
    )
  );

  CREATE INDEX IF NOT EXISTS orders_user_created_idx ON orders (user_id, created_at DESC);

  CREATE TABLE IF NOT EXISTS order_items (
    id                     BIGSERIAL PRIMARY KEY,
    order_id               BIGINT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    line_position          INT NOT NULL CHECK (line_position >= 0),
    line_type              TEXT NOT NULL CHECK (line_type IN ('single', 'box')),
    product_id             INT REFERENCES products(id) ON DELETE SET NULL,
    display_name           TEXT NOT NULL,
    quantity               INT NOT NULL CHECK (quantity > 0),
    pack_size              INT,
    regular_unit_price     NUMERIC(12, 2) NOT NULL CHECK (regular_unit_price >= 0),
    unit_price             NUMERIC(12, 2) NOT NULL CHECK (unit_price >= 0),
    promotion_discount     NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (promotion_discount >= 0),
    pack_discount          NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (pack_discount >= 0),
    line_total             NUMERIC(12, 2) NOT NULL CHECK (
      line_total = unit_price * quantity
      AND line_total = regular_unit_price * quantity - promotion_discount - pack_discount
    ),
    UNIQUE (order_id, line_position),
    CHECK (
      (line_type = 'single' AND pack_size IS NULL)
      OR (line_type = 'box' AND product_id IS NULL AND pack_size IN (4, 6, 12))
    )
  );

  CREATE INDEX IF NOT EXISTS order_items_order_idx ON order_items (order_id);

  CREATE TABLE IF NOT EXISTS order_box_items (
    order_item_id          BIGINT NOT NULL REFERENCES order_items(id) ON DELETE CASCADE,
    slot                   INT NOT NULL CHECK (slot >= 0),
    product_id             INT REFERENCES products(id) ON DELETE SET NULL,
    product_name           TEXT NOT NULL,
    regular_price          NUMERIC(12, 2) NOT NULL CHECK (regular_price >= 0),
    unit_price             NUMERIC(12, 2) NOT NULL CHECK (unit_price >= 0),
    PRIMARY KEY (order_item_id, slot)
  );
`;

const CHECKOUT_UPGRADE_SCHEMA = `
  -- P2a-2.3/P2b-1: additive NCR snapshots and hosted-payment lifecycle.
  ALTER TABLE orders ADD COLUMN IF NOT EXISTS region_code TEXT;
  ALTER TABLE orders ADD COLUMN IF NOT EXISTS region_name TEXT;
  ALTER TABLE orders ADD COLUMN IF NOT EXISTS city_code TEXT;
  ALTER TABLE orders ADD COLUMN IF NOT EXISTS barangay_code TEXT;
  ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_method_v2 TEXT
    CHECK (payment_method_v2 IN ('cash_on_delivery', 'cash_on_pickup', 'gcash', 'maya', 'card'));
  ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_state TEXT
    CHECK (payment_state IN ('pending_cash', 'awaiting_payment', 'processing', 'paid', 'failed', 'expired', 'cancelled', 'refunded'));

  CREATE TABLE IF NOT EXISTS payment_attempts (
    id                    BIGSERIAL PRIMARY KEY,
    public_id             UUID NOT NULL UNIQUE,
    order_id              BIGINT NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
    provider              TEXT NOT NULL CHECK (provider = 'paymongo'),
    payment_method        TEXT NOT NULL CHECK (payment_method IN ('gcash', 'maya', 'card')),
    provider_method       TEXT NOT NULL CHECK (provider_method IN ('gcash', 'paymaya', 'card')),
    idempotency_key       UUID NOT NULL,
    provider_session_id   TEXT UNIQUE,
    provider_payment_id   TEXT UNIQUE,
    checkout_url          TEXT,
    amount_centavos       BIGINT NOT NULL CHECK (amount_centavos > 0),
    currency              CHAR(3) NOT NULL DEFAULT 'PHP' CHECK (currency = 'PHP'),
    status                TEXT NOT NULL CHECK (status IN ('creating', 'active', 'processing', 'paid', 'expired', 'failed', 'cancelled')),
    failure_code          TEXT,
    expires_at            TIMESTAMPTZ,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (order_id, idempotency_key)
  );

  ALTER TABLE payment_attempts ADD COLUMN IF NOT EXISTS flow_type TEXT NOT NULL DEFAULT 'hosted_checkout'
    CHECK (flow_type IN ('hosted_checkout', 'payment_intent'));
  ALTER TABLE payment_attempts ADD COLUMN IF NOT EXISTS provider_intent_id TEXT UNIQUE;

  CREATE INDEX IF NOT EXISTS payment_attempts_order_idx ON payment_attempts (order_id, created_at DESC);
  CREATE UNIQUE INDEX IF NOT EXISTS payment_attempts_one_open_per_order_idx
    ON payment_attempts (order_id) WHERE status IN ('creating', 'active', 'processing');
  CREATE UNIQUE INDEX IF NOT EXISTS payment_attempts_one_paid_per_order_idx
    ON payment_attempts (order_id) WHERE status = 'paid';

  CREATE TABLE IF NOT EXISTS payment_webhook_events (
    provider              TEXT NOT NULL CHECK (provider = 'paymongo'),
    event_id              TEXT NOT NULL,
    event_type            TEXT NOT NULL,
    payload_hash          CHAR(64) NOT NULL,
    livemode              BOOLEAN NOT NULL,
    received_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    processed_at          TIMESTAMPTZ,
    PRIMARY KEY (provider, event_id)
  );
`;

const CARD_DEMO_SCHEMA = `
  -- P2d-2: financially isolated card-payment demonstration records.
  ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_is_demo BOOLEAN NOT NULL DEFAULT false;

  CREATE TABLE IF NOT EXISTS demo_payment_attempts (
    id                    BIGSERIAL PRIMARY KEY,
    public_id             UUID NOT NULL UNIQUE,
    order_id              BIGINT NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
    scenario              TEXT NOT NULL CHECK (scenario IN ('visa_approved', 'mastercard_declined')),
    idempotency_key       UUID NOT NULL,
    amount_centavos       BIGINT NOT NULL CHECK (amount_centavos > 0),
    currency              CHAR(3) NOT NULL DEFAULT 'PHP' CHECK (currency = 'PHP'),
    status                TEXT NOT NULL CHECK (status IN ('demo_approved', 'demo_declined')),
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (order_id, idempotency_key)
  );

  CREATE INDEX IF NOT EXISTS demo_payment_attempts_order_idx
    ON demo_payment_attempts (order_id, created_at DESC);
  CREATE UNIQUE INDEX IF NOT EXISTS demo_payment_attempts_one_approval_per_order_idx
    ON demo_payment_attempts (order_id) WHERE status = 'demo_approved';
`;

const WALLET_DEMO_SCHEMA = `
  -- P2e: financially isolated wallet-payment demonstration records.
  CREATE TABLE IF NOT EXISTS wallet_demo_attempts (
    id                    BIGSERIAL PRIMARY KEY,
    public_id             UUID NOT NULL UNIQUE,
    order_id              BIGINT NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
    wallet_method         TEXT NOT NULL CHECK (wallet_method IN ('gcash', 'maya')),
    idempotency_key       UUID NOT NULL,
    amount_centavos       BIGINT NOT NULL CHECK (amount_centavos > 0),
    currency              CHAR(3) NOT NULL DEFAULT 'PHP' CHECK (currency = 'PHP'),
    outcome               TEXT NOT NULL CHECK (outcome IN ('demo_approved', 'demo_cancelled')),
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (order_id, idempotency_key)
  );

  CREATE INDEX IF NOT EXISTS wallet_demo_attempts_order_idx
    ON wallet_demo_attempts (order_id, created_at DESC);
  CREATE UNIQUE INDEX IF NOT EXISTS wallet_demo_attempts_one_approval_per_order_idx
    ON wallet_demo_attempts (order_id) WHERE outcome = 'demo_approved';
`;

const ORDER_AGREEMENT_SCHEMA = `
  -- P3: nullable acceptance snapshot for the development-only draft order agreement.
  ALTER TABLE orders ADD COLUMN IF NOT EXISTS order_agreement_version TEXT;
  ALTER TABLE orders ADD COLUMN IF NOT EXISTS order_agreement_accepted_at TIMESTAMPTZ;
`;

const ADDRESS_BOOK_SCHEMA = `
  -- P4B: customer-owned NCR delivery addresses. Orders keep independent snapshots.
  CREATE TABLE IF NOT EXISTS customer_addresses (
    id               BIGSERIAL PRIMARY KEY,
    public_id        UUID NOT NULL UNIQUE,
    user_id          INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    label            TEXT NOT NULL CHECK (char_length(label) BETWEEN 1 AND 30),
    recipient_name   TEXT NOT NULL CHECK (char_length(recipient_name) BETWEEN 2 AND 80),
    recipient_phone  TEXT NOT NULL CHECK (char_length(recipient_phone) BETWEEN 12 AND 13),
    address_line_1   TEXT NOT NULL CHECK (char_length(address_line_1) BETWEEN 5 AND 120),
    address_line_2   TEXT NOT NULL DEFAULT '' CHECK (char_length(address_line_2) <= 120),
    region_code      TEXT NOT NULL,
    region_name      TEXT NOT NULL,
    province         TEXT NOT NULL,
    city_code        TEXT NOT NULL,
    city             TEXT NOT NULL,
    barangay_code    TEXT NOT NULL,
    barangay         TEXT NOT NULL,
    postal_code      CHAR(4) NOT NULL CHECK (postal_code ~ '^[0-9]{4}$'),
    is_default       BOOLEAN NOT NULL DEFAULT false,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  CREATE INDEX IF NOT EXISTS customer_addresses_user_idx
    ON customer_addresses (user_id, updated_at DESC, id DESC);
  CREATE UNIQUE INDEX IF NOT EXISTS customer_addresses_one_default_idx
    ON customer_addresses (user_id) WHERE is_default;
`;

const FAVORITES_PREFERENCES_SCHEMA = `
  -- P4C: customer-owned favorites and persisted accessibility preferences.
  CREATE TABLE IF NOT EXISTS user_favorites (
    user_id    INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    product_id INT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, product_id)
  );

  CREATE INDEX IF NOT EXISTS user_favorites_user_created_idx
    ON user_favorites (user_id, created_at DESC, product_id DESC);

  CREATE TABLE IF NOT EXISTS user_preferences (
    user_id       INT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    reduce_motion BOOLEAN NOT NULL DEFAULT false,
    larger_text   BOOLEAN NOT NULL DEFAULT false,
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
  );
`;

const ORDER_IMAGE_SNAPSHOT_SCHEMA = `
  -- P4B-UX: immutable catalog-image references for new order snapshots.
  ALTER TABLE order_items ADD COLUMN IF NOT EXISTS image_url TEXT;
  ALTER TABLE order_box_items ADD COLUMN IF NOT EXISTS image_url TEXT;
`;

const ORDER_LIFECYCLE_SCHEMA = `
  -- P5: server-authoritative fulfillment history, cancellation review and operator identity.
  CREATE TABLE IF NOT EXISTS order_operators (
    id                 BIGSERIAL PRIMARY KEY,
    public_id          UUID NOT NULL UNIQUE,
    display_name       TEXT NOT NULL CHECK (char_length(display_name) BETWEEN 2 AND 80),
    credential_hash    TEXT NOT NULL,
    credential_version INT NOT NULL DEFAULT 1 CHECK (credential_version > 0),
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    rotated_at         TIMESTAMPTZ,
    revoked_at         TIMESTAMPTZ,
    last_used_at       TIMESTAMPTZ
  );

  CREATE TABLE IF NOT EXISTS order_status_events (
    id                  BIGSERIAL PRIMARY KEY,
    public_id           UUID NOT NULL UNIQUE,
    order_id            BIGINT NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
    from_status         TEXT CHECK (from_status IS NULL OR from_status IN ('placed', 'confirmed', 'preparing', 'ready', 'out_for_delivery', 'completed', 'cancelled')),
    to_status           TEXT NOT NULL CHECK (to_status IN ('placed', 'confirmed', 'preparing', 'ready', 'out_for_delivery', 'completed', 'cancelled')),
    actor_type          TEXT NOT NULL CHECK (actor_type IN ('customer', 'operator', 'system')),
    actor_user_id       INT REFERENCES users(id) ON DELETE RESTRICT,
    operator_id         BIGINT REFERENCES order_operators(id) ON DELETE RESTRICT,
    idempotency_key     UUID NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (order_id, idempotency_key),
    CHECK (
      (actor_type = 'customer' AND actor_user_id IS NOT NULL AND operator_id IS NULL)
      OR (actor_type = 'operator' AND actor_user_id IS NULL AND operator_id IS NOT NULL)
      OR (actor_type = 'system' AND actor_user_id IS NULL AND operator_id IS NULL)
    )
  );

  CREATE INDEX IF NOT EXISTS order_status_events_order_idx
    ON order_status_events (order_id, created_at, id);

  CREATE TABLE IF NOT EXISTS order_cancellation_requests (
    id                         BIGSERIAL PRIMARY KEY,
    public_id                  UUID NOT NULL UNIQUE,
    order_id                   BIGINT NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
    requested_by_user_id       INT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    idempotency_key            UUID NOT NULL,
    status                     TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'declined')),
    refund_review_status       TEXT NOT NULL DEFAULT 'not_required'
      CHECK (refund_review_status IN ('not_required', 'review_required')),
    resolved_by_operator_id    BIGINT REFERENCES order_operators(id) ON DELETE RESTRICT,
    requested_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
    resolved_at                TIMESTAMPTZ,
    UNIQUE (order_id, idempotency_key),
    CHECK (
      (status = 'pending' AND resolved_at IS NULL AND resolved_by_operator_id IS NULL)
      OR (status IN ('approved', 'declined') AND resolved_at IS NOT NULL)
    )
  );

  CREATE INDEX IF NOT EXISTS order_cancellation_requests_order_idx
    ON order_cancellation_requests (order_id, requested_at DESC, id DESC);
  CREATE UNIQUE INDEX IF NOT EXISTS order_cancellation_requests_one_pending_idx
    ON order_cancellation_requests (order_id) WHERE status = 'pending';
`;

const REFUND_MANAGEMENT_SCHEMA = `
  -- P5R-A: internal full-refund review and audit records; no provider execution.
  ALTER TABLE order_operators
    ADD COLUMN IF NOT EXISTS can_manage_refunds BOOLEAN NOT NULL DEFAULT false;

  CREATE TABLE IF NOT EXISTS order_refunds (
    id                         BIGSERIAL PRIMARY KEY,
    public_id                  UUID NOT NULL UNIQUE,
    order_id                   BIGINT NOT NULL UNIQUE REFERENCES orders(id) ON DELETE RESTRICT,
    cancellation_request_id    BIGINT NOT NULL UNIQUE REFERENCES order_cancellation_requests(id) ON DELETE RESTRICT,
    payment_attempt_id         BIGINT NOT NULL UNIQUE REFERENCES payment_attempts(id) ON DELETE RESTRICT,
    provider                   TEXT NOT NULL CHECK (provider = 'paymongo'),
    payment_method             TEXT NOT NULL CHECK (payment_method IN ('gcash', 'maya')),
    provider_payment_id        TEXT NOT NULL UNIQUE CHECK (left(provider_payment_id, 4) = 'pay_'),
    amount_centavos            BIGINT NOT NULL CHECK (amount_centavos > 0),
    approved_amount_centavos   BIGINT CHECK (approved_amount_centavos = amount_centavos),
    currency                   CHAR(3) NOT NULL DEFAULT 'PHP' CHECK (currency = 'PHP'),
    status                     TEXT NOT NULL DEFAULT 'review_required'
      CHECK (status IN ('review_required', 'approved', 'processing', 'refunded', 'rejected', 'failed')),
    review_reason              TEXT CHECK (review_reason IS NULL OR char_length(review_reason) BETWEEN 2 AND 500),
    reviewed_by_operator_id    BIGINT REFERENCES order_operators(id) ON DELETE RESTRICT,
    reviewed_at                TIMESTAMPTZ,
    created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (
      (status = 'review_required' AND approved_amount_centavos IS NULL
        AND reviewed_by_operator_id IS NULL AND reviewed_at IS NULL)
      OR
      (status = 'rejected' AND approved_amount_centavos IS NULL
        AND reviewed_by_operator_id IS NOT NULL AND reviewed_at IS NOT NULL)
      OR
      (status IN ('approved', 'processing', 'refunded', 'failed')
        AND approved_amount_centavos = amount_centavos
        AND reviewed_by_operator_id IS NOT NULL AND reviewed_at IS NOT NULL)
    )
  );

  CREATE INDEX IF NOT EXISTS order_refunds_status_idx ON order_refunds (status, updated_at, id);

  CREATE TABLE IF NOT EXISTS refund_attempts (
    id                    BIGSERIAL PRIMARY KEY,
    public_id             UUID NOT NULL UNIQUE,
    refund_id             BIGINT NOT NULL REFERENCES order_refunds(id) ON DELETE RESTRICT,
    idempotency_key       UUID NOT NULL,
    provider              TEXT NOT NULL CHECK (provider = 'paymongo'),
    provider_refund_id    TEXT UNIQUE,
    amount_centavos       BIGINT NOT NULL CHECK (amount_centavos > 0),
    currency              CHAR(3) NOT NULL DEFAULT 'PHP' CHECK (currency = 'PHP'),
    status                TEXT NOT NULL CHECK (status IN ('creating', 'pending', 'processing', 'succeeded', 'failed')),
    failure_code          TEXT,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (refund_id, idempotency_key)
  );

  CREATE UNIQUE INDEX IF NOT EXISTS refund_attempts_one_open_idx
    ON refund_attempts (refund_id) WHERE status IN ('creating', 'pending', 'processing');
  CREATE UNIQUE INDEX IF NOT EXISTS refund_attempts_one_succeeded_idx
    ON refund_attempts (refund_id) WHERE status = 'succeeded';

  CREATE TABLE IF NOT EXISTS refund_events (
    id                    BIGSERIAL PRIMARY KEY,
    public_id             UUID NOT NULL UNIQUE,
    refund_id             BIGINT NOT NULL REFERENCES order_refunds(id) ON DELETE RESTRICT,
    from_status           TEXT CHECK (from_status IS NULL OR from_status IN ('review_required', 'approved', 'processing', 'refunded', 'rejected', 'failed')),
    to_status             TEXT NOT NULL CHECK (to_status IN ('review_required', 'approved', 'processing', 'refunded', 'rejected', 'failed')),
    actor_type            TEXT NOT NULL CHECK (actor_type IN ('operator', 'system')),
    operator_id           BIGINT REFERENCES order_operators(id) ON DELETE RESTRICT,
    idempotency_key       UUID NOT NULL,
    reason                TEXT NOT NULL CHECK (char_length(reason) BETWEEN 2 AND 500),
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (refund_id, idempotency_key),
    CHECK (
      (actor_type = 'operator' AND operator_id IS NOT NULL)
      OR (actor_type = 'system' AND operator_id IS NULL)
    )
  );

  CREATE INDEX IF NOT EXISTS refund_events_refund_idx
    ON refund_events (refund_id, created_at, id);
`;

const REORDER_SCHEMA = `
  -- P7: durable, owner-scoped idempotency for reorder-to-cart requests.
  CREATE TABLE IF NOT EXISTS order_reorder_attempts (
    id              BIGSERIAL PRIMARY KEY,
    user_id         INT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    source_order_id BIGINT NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
    idempotency_key UUID NOT NULL,
    result_json     JSONB NOT NULL CHECK (jsonb_typeof(result_json) = 'object'),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (user_id, idempotency_key)
  );

  CREATE INDEX IF NOT EXISTS order_reorder_attempts_source_idx
    ON order_reorder_attempts (source_order_id, created_at DESC, id DESC);
`;

const AUTH_SECURITY_SCHEMA = `
  -- P8A: revocable customer sessions and durable password-change controls.
  ALTER TABLE users ADD COLUMN IF NOT EXISTS auth_version INT NOT NULL DEFAULT 1;
  ALTER TABLE users ADD COLUMN IF NOT EXISTS password_changed_at TIMESTAMPTZ;
  ALTER TABLE users ADD COLUMN IF NOT EXISTS account_status TEXT NOT NULL DEFAULT 'active';
  ALTER TABLE users ADD COLUMN IF NOT EXISTS deactivated_at TIMESTAMPTZ;

  DO $$ BEGIN
    ALTER TABLE users ADD CONSTRAINT users_auth_version_positive CHECK (auth_version > 0);
  EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  DO $$ BEGIN
    ALTER TABLE users ADD CONSTRAINT users_account_status_valid
      CHECK (account_status IN ('active', 'deactivated'));
  EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  DO $$ BEGIN
    ALTER TABLE users ADD CONSTRAINT users_deactivation_consistent CHECK (
      (account_status = 'active' AND deactivated_at IS NULL)
      OR (account_status = 'deactivated' AND deactivated_at IS NOT NULL)
    );
  EXCEPTION WHEN duplicate_object THEN NULL; END $$;

  CREATE INDEX IF NOT EXISTS users_account_status_idx ON users (account_status);

  CREATE TABLE IF NOT EXISTS auth_rate_limits (
    id          BIGSERIAL PRIMARY KEY,
    user_id     INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    action      TEXT NOT NULL CHECK (action = 'change_password'),
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  CREATE INDEX IF NOT EXISTS auth_rate_limits_window_idx
    ON auth_rate_limits (user_id, action, occurred_at DESC);

  CREATE TABLE IF NOT EXISTS account_security_events (
    id         BIGSERIAL PRIMARY KEY,
    user_id    INT REFERENCES users(id) ON DELETE SET NULL,
    event_type TEXT NOT NULL CHECK (event_type IN (
      'password_change_succeeded',
      'password_change_failed',
      'password_change_throttled'
    )),
    details    JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(details) = 'object'),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  CREATE INDEX IF NOT EXISTS account_security_events_user_idx
    ON account_security_events (user_id, created_at DESC, id DESC);
`;

const PASSWORD_RECOVERY_SCHEMA = `
  -- P8B-1: hashed, expiring recovery tokens and privacy-safe abuse controls.
  CREATE TABLE IF NOT EXISTS password_reset_tokens (
    id              BIGSERIAL PRIMARY KEY,
    selector        UUID NOT NULL UNIQUE,
    user_id         INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash      CHAR(64) NOT NULL,
    expires_at      TIMESTAMPTZ NOT NULL,
    used_at         TIMESTAMPTZ,
    invalidated_at  TIMESTAMPTZ,
    failed_attempts INT NOT NULL DEFAULT 0 CHECK (failed_attempts BETWEEN 0 AND 5),
    delivery_status TEXT NOT NULL DEFAULT 'pending'
      CHECK (delivery_status IN ('pending', 'sent', 'failed')),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (expires_at > created_at),
    CHECK (used_at IS NULL OR invalidated_at IS NULL)
  );

  CREATE INDEX IF NOT EXISTS password_reset_tokens_user_idx
    ON password_reset_tokens (user_id, created_at DESC, id DESC);
  CREATE INDEX IF NOT EXISTS password_reset_tokens_expiry_idx
    ON password_reset_tokens (expires_at) WHERE used_at IS NULL AND invalidated_at IS NULL;

  CREATE TABLE IF NOT EXISTS auth_recovery_rate_limits (
    id              BIGSERIAL PRIMARY KEY,
    scope           TEXT NOT NULL CHECK (scope IN ('email', 'ip')),
    identifier_hash CHAR(64) NOT NULL,
    occurred_at     TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  CREATE INDEX IF NOT EXISTS auth_recovery_rate_limits_window_idx
    ON auth_recovery_rate_limits (scope, identifier_hash, occurred_at DESC);

  CREATE TABLE IF NOT EXISTS password_recovery_events (
    id         BIGSERIAL PRIMARY KEY,
    user_id    INT REFERENCES users(id) ON DELETE SET NULL,
    event_type TEXT NOT NULL CHECK (event_type IN (
      'reset_requested', 'reset_throttled', 'delivery_succeeded', 'delivery_failed',
      'token_rejected', 'password_reset_succeeded'
    )),
    details    JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(details) = 'object'),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  CREATE INDEX IF NOT EXISTS password_recovery_events_user_idx
    ON password_recovery_events (user_id, created_at DESC, id DESC);
`;

const GOOGLE_AUTH_SCHEMA = `
  -- Google-only accounts have no reusable local password until one is set through recovery.
  ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;

  CREATE TABLE IF NOT EXISTS user_google_identities (
    id              BIGSERIAL PRIMARY KEY,
    user_id         INT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    google_subject  TEXT NOT NULL UNIQUE CHECK (char_length(google_subject) BETWEEN 1 AND 255),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_login_at   TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS google_auth_nonces (
    selector              UUID PRIMARY KEY,
    nonce_hash            CHAR(64) NOT NULL UNIQUE,
    challenge_hash        CHAR(64) UNIQUE,
    google_subject        TEXT,
    verified_email        TEXT,
    first_name            TEXT,
    last_name             TEXT,
    state                 TEXT NOT NULL DEFAULT 'issued'
      CHECK (state IN ('issued', 'signup_required', 'link_required')),
    expires_at            TIMESTAMPTZ NOT NULL,
    challenge_expires_at  TIMESTAMPTZ,
    used_at               TIMESTAMPTZ,
    completed_at          TIMESTAMPTZ,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (expires_at > created_at),
    CHECK (completed_at IS NULL OR used_at IS NOT NULL),
    CHECK (
      (state = 'issued' AND challenge_hash IS NULL AND google_subject IS NULL)
      OR
      (state IN ('signup_required', 'link_required') AND challenge_hash IS NOT NULL
        AND google_subject IS NOT NULL AND verified_email IS NOT NULL
        AND challenge_expires_at IS NOT NULL)
    )
  );

  CREATE INDEX IF NOT EXISTS google_auth_nonces_expiry_idx
    ON google_auth_nonces (expires_at) WHERE used_at IS NULL;
  CREATE INDEX IF NOT EXISTS google_auth_challenges_expiry_idx
    ON google_auth_nonces (challenge_expires_at) WHERE completed_at IS NULL;

  CREATE TABLE IF NOT EXISTS google_auth_events (
    id          BIGSERIAL PRIMARY KEY,
    user_id     INT REFERENCES users(id) ON DELETE SET NULL,
    event_type  TEXT NOT NULL CHECK (event_type IN (
      'google_login_succeeded', 'google_login_rejected',
      'google_signup_succeeded', 'google_link_succeeded', 'google_link_rejected'
    )),
    details     JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(details) = 'object'),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  CREATE INDEX IF NOT EXISTS google_auth_events_user_idx
    ON google_auth_events (user_id, created_at DESC, id DESC);
`;

const GOOGLE_AUTH_INTENT_SCHEMA = `
  -- Binds explicit login/signup intent to each one-time Google authentication attempt.
  -- Nullable and additive: existing nonce rows (and in-flight attempts) stay valid; the
  -- service rejects new issuance without a valid intent, so missing intent never defaults to signup.
  ALTER TABLE google_auth_nonces ADD COLUMN IF NOT EXISTS intent TEXT;

  ALTER TABLE google_auth_nonces DROP CONSTRAINT IF EXISTS google_auth_nonces_intent_check;
  ALTER TABLE google_auth_nonces
    ADD CONSTRAINT google_auth_nonces_intent_check
    CHECK (intent IS NULL OR intent IN ('login', 'signup'));
`;

const NOTIFICATIONS_SCHEMA = `
  -- Owner-scoped in-app notifications generated from committed business operations.
  -- Additive: no existing table is altered destructively; dedupe is source-event based.
  CREATE TABLE IF NOT EXISTS notifications (
    id          BIGSERIAL PRIMARY KEY,
    public_id   UUID NOT NULL UNIQUE,
    user_id     INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    category    TEXT NOT NULL CHECK (category IN ('order', 'payment', 'security')),
    event_type  TEXT NOT NULL CHECK (event_type IN (
      'order_placed', 'order_confirmed', 'order_preparing', 'order_ready',
      'order_out_for_delivery', 'order_completed', 'order_cancelled',
      'payment_paid', 'payment_failed', 'refund_approved', 'refund_rejected',
      'password_changed'
    )),
    title       TEXT NOT NULL CHECK (char_length(title) BETWEEN 1 AND 120),
    body        TEXT NOT NULL CHECK (char_length(body) BETWEEN 1 AND 300),
    link_path   TEXT CHECK (link_path IS NULL OR link_path ~ '^/[A-Za-z0-9/_-]*$'),
    dedupe_key  TEXT NOT NULL,
    read_at     TIMESTAMPTZ,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (user_id, dedupe_key)
  );

  CREATE INDEX IF NOT EXISTS notifications_user_idx
    ON notifications (user_id, created_at DESC, id DESC);
  CREATE INDEX IF NOT EXISTS notifications_user_unread_idx
    ON notifications (user_id) WHERE read_at IS NULL;

  -- Optional order-progress notification preference; essential payment/security always deliver.
  -- Defaults to true so existing customers keep receiving order updates.
  ALTER TABLE user_preferences ADD COLUMN IF NOT EXISTS notify_order_updates BOOLEAN NOT NULL DEFAULT true;
`;

const VERIFICATION_CHALLENGES_SCHEMA = `
  -- Reusable identity-verification challenges for sensitive account changes. Codes are never
  -- stored in plaintext (keyed HMAC only). Each challenge is owner-scoped, operation-bound,
  -- single-use, expiring, and optionally target-bound (e.g. a new email/phone).
  CREATE TABLE IF NOT EXISTS verification_challenges (
    id             BIGSERIAL PRIMARY KEY,
    public_id      UUID NOT NULL UNIQUE,
    user_id        INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    operation      TEXT NOT NULL CHECK (operation IN (
      'change_phone', 'change_email', 'set_password', 'change_password'
    )),
    channel        TEXT NOT NULL CHECK (channel IN ('email', 'google')),
    code_hash      CHAR(64) NOT NULL,
    target_hash    TEXT,
    attempt_count  INT NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    expires_at     TIMESTAMPTZ NOT NULL,
    consumed_at    TIMESTAMPTZ,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (expires_at > created_at)
  );

  -- At most one active (unconsumed, unexpired is enforced in code) challenge row per
  -- user+operation is kept by the service; this index speeds the owner/operation lookup.
  CREATE INDEX IF NOT EXISTS verification_challenges_user_op_idx
    ON verification_challenges (user_id, operation, created_at DESC, id DESC);
  CREATE INDEX IF NOT EXISTS verification_challenges_expiry_idx
    ON verification_challenges (expires_at) WHERE consumed_at IS NULL;

  -- Source/customer rate limiting for verification, mirroring the recovery rate-limit shape.
  CREATE TABLE IF NOT EXISTS verification_rate_limits (
    id              BIGSERIAL PRIMARY KEY,
    scope           TEXT NOT NULL CHECK (scope IN ('user', 'ip')),
    identifier_hash CHAR(64) NOT NULL,
    occurred_at     TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS verification_rate_limits_window_idx
    ON verification_rate_limits (scope, identifier_hash, occurred_at DESC);

  -- Sanitized audit trail. Never stores codes, tokens, or credentials; only an event reason.
  CREATE TABLE IF NOT EXISTS verification_events (
    id          BIGSERIAL PRIMARY KEY,
    user_id     INT REFERENCES users(id) ON DELETE SET NULL,
    operation   TEXT,
    event_type  TEXT NOT NULL CHECK (event_type IN (
      'challenge_started', 'challenge_throttled', 'verify_succeeded',
      'verify_failed', 'challenge_consumed'
    )),
    details     JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(details) = 'object'),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS verification_events_user_idx
    ON verification_events (user_id, created_at DESC, id DESC);
`;

const VERIFICATION_VERIFIED_STATE_SCHEMA = `
  -- Explicit "verified" authorization state: a correct code sets verified_at WITHOUT consuming
  -- the challenge, so the final protected change can atomically consume it in one transaction.
  -- Additive and nullable; existing rows are unaffected.
  ALTER TABLE verification_challenges ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ;

  -- Allow auditing verified profile-contact changes (Change Phone, and future verified changes).
  ALTER TABLE account_security_events DROP CONSTRAINT IF EXISTS account_security_events_event_type_check;
  ALTER TABLE account_security_events
    ADD CONSTRAINT account_security_events_event_type_check
    CHECK (event_type IN (
      'password_change_succeeded', 'password_change_failed', 'password_change_throttled',
      'phone_change_succeeded'
    ));

  -- Allow an essential in-app "security_alert" notification for sensitive account changes.
  ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_event_type_check;
  ALTER TABLE notifications
    ADD CONSTRAINT notifications_event_type_check
    CHECK (event_type IN (
      'order_placed', 'order_confirmed', 'order_preparing', 'order_ready',
      'order_out_for_delivery', 'order_completed', 'order_cancelled',
      'payment_paid', 'payment_failed', 'refund_approved', 'refund_rejected',
      'password_changed', 'security_alert'
    ));
`;

const VERIFICATION_AUTH_VERSION_SCHEMA = `
  -- Binds a verification challenge to the account's auth_version at issuance, so a password
  -- change or any auth_version bump invalidates outstanding verified authorizations even inside
  -- the final change transaction (defense in depth beyond the requireAuth middleware check).
  -- Additive and nullable; existing rows (treated as unbound) are unaffected.
  ALTER TABLE verification_challenges ADD COLUMN IF NOT EXISTS auth_version INT;
`;

const CHANGE_EMAIL_SCHEMA = `
  -- Phase 4 Change Email. Mandatory reauthentication produces a short-lived, server-side,
  -- purpose-bound, single-use authorization that the final change transaction consumes. The
  -- proof is bound to the customer, the change_email operation, and the auth_version at issuance,
  -- so a password change (or any auth_version bump) invalidates it. Only a keyed reference is
  -- stored; no password or token is ever persisted here.
  CREATE TABLE IF NOT EXISTS reauth_authorizations (
    id            BIGSERIAL PRIMARY KEY,
    public_id     UUID NOT NULL UNIQUE,
    user_id       INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    operation     TEXT NOT NULL,
    method        TEXT NOT NULL CHECK (method IN ('password', 'google')),
    auth_version  INT NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at    TIMESTAMPTZ NOT NULL,
    consumed_at   TIMESTAMPTZ
  );
  CREATE INDEX IF NOT EXISTS reauth_authorizations_user_op_idx
    ON reauth_authorizations (user_id, operation, created_at DESC) WHERE consumed_at IS NULL;

  -- Allow auditing verified email changes and reauthentication outcomes.
  ALTER TABLE account_security_events DROP CONSTRAINT IF EXISTS account_security_events_event_type_check;
  ALTER TABLE account_security_events
    ADD CONSTRAINT account_security_events_event_type_check
    CHECK (event_type IN (
      'password_change_succeeded', 'password_change_failed', 'password_change_throttled',
      'phone_change_succeeded',
      'email_change_succeeded', 'email_change_failed',
      'reauth_succeeded', 'reauth_failed'
    ));
`;

const PROFILE_FIELDS_SCHEMA = `
  -- Optional, additive customer profile fields. Nullable so existing records are preserved
  -- and neither field is ever required for signup, Google sign-up, or checkout.
  ALTER TABLE users ADD COLUMN IF NOT EXISTS gender TEXT;
  ALTER TABLE users DROP CONSTRAINT IF EXISTS users_gender_check;
  ALTER TABLE users
    ADD CONSTRAINT users_gender_check
    CHECK (gender IS NULL OR gender IN ('female', 'male', 'non_binary', 'prefer_not_to_say'));
  ALTER TABLE users ADD COLUMN IF NOT EXISTS date_of_birth DATE;
  ALTER TABLE users DROP CONSTRAINT IF EXISTS users_date_of_birth_check;
  ALTER TABLE users
    ADD CONSTRAINT users_date_of_birth_check
    CHECK (date_of_birth IS NULL OR date_of_birth <= CURRENT_DATE);
`;

/** Creates the tables (if missing) and loads the Cookie Fluffs menu. */
export async function initDb() {
  if (!pool) return { ready: false, seeded: 0 };

  await query(SCHEMA);
  await applyOrderSchemaOnce();
  await applyCheckoutUpgradeOnce();
  await applyCardDemoOnce();
  await applyWalletDemoOnce();
  await applyOrderAgreementOnce();
  await applyAddressBookOnce();
  await applyFavoritesPreferencesOnce();
  await applyOrderImageSnapshotOnce();
  await applyOrderLifecycleOnce();
  const refundBackfill = await applyRefundManagementOnce();
  await applyReorderOnce();
  await applyAuthSecurityOnce();
  await applyPasswordRecoveryOnce();
  await applyGoogleAuthOnce();
  await applyGoogleAuthIntentOnce();
  await applyNotificationsOnce();
  await applyProfileFieldsOnce();
  await applyVerificationChallengesOnce();
  await applyVerificationVerifiedStateOnce();
  await applyVerificationAuthVersionOnce();
  await applyChangeEmailOnce();
  await splitNamesOnce();

  let seeded = 0;
  for (const p of SEED_PRODUCTS) {
    const res = await query(
      `INSERT INTO products
         (slug, name, tagline, description, flavor_notes, category, price,
          rating, reviews_count, calories, allergens, badge, image_url,
          is_best_seller, is_new, sale_price, season)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
       ON CONFLICT (slug) DO NOTHING`,
      [
        p.slug, p.name, p.tagline, p.description, p.flavorNotes, p.category, p.price,
        p.rating, p.reviewsCount, p.calories, p.allergens, p.badge, p.imageUrl,
        Boolean(p.isBestSeller), Boolean(p.isNew), p.salePrice ?? null, p.season ?? null,
      ],
    );
    seeded += res.rowCount;
  }

  await applyCollectionsOnce();
  await retireOldMenuOnce();
  await applySeasonalMenuOnce();
  await applySeasonalMenuV2Once();
  await applyVouchersOnce();
  return { ready: true, seeded, refundBackfill };
}

/** Adds revocable sessions, password-change throttling, and sanitized audit events. */
async function applyAuthSecurityOnce() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const claim = await client.query(
      `INSERT INTO app_meta (key, value)
       VALUES ('auth_security_v1', 'pending')
       ON CONFLICT (key) DO NOTHING
       RETURNING key`,
    );
    if (!claim.rowCount) {
      await client.query('ROLLBACK');
      return;
    }
    await client.query(AUTH_SECURITY_SCHEMA);
    await client.query(`UPDATE app_meta SET value = now()::text WHERE key = 'auth_security_v1'`);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/** Adds password recovery without modifying existing credentials or sessions. */
async function applyPasswordRecoveryOnce() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const claim = await client.query(
      `INSERT INTO app_meta (key, value)
       VALUES ('password_recovery_v1', 'pending')
       ON CONFLICT (key) DO NOTHING
       RETURNING key`,
    );
    if (!claim.rowCount) {
      await client.query('ROLLBACK');
      return;
    }
    await client.query(PASSWORD_RECOVERY_SCHEMA);
    await client.query(`UPDATE app_meta SET value = now()::text WHERE key = 'password_recovery_v1'`);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/** Adds one-time Google identity challenges and stable subject associations. */
async function applyGoogleAuthOnce() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const claim = await client.query(
      `INSERT INTO app_meta (key, value)
       VALUES ('google_auth_v1', 'pending')
       ON CONFLICT (key) DO NOTHING
       RETURNING key`,
    );
    if (!claim.rowCount) {
      await client.query('ROLLBACK');
      return;
    }
    await client.query(GOOGLE_AUTH_SCHEMA);
    await client.query(`UPDATE app_meta SET value = now()::text WHERE key = 'google_auth_v1'`);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/** Binds explicit login/signup intent to each single-use Google authentication attempt. */
async function applyGoogleAuthIntentOnce() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const claim = await client.query(
      `INSERT INTO app_meta (key, value)
       VALUES ('google_auth_intent_v1', 'pending')
       ON CONFLICT (key) DO NOTHING
       RETURNING key`,
    );
    if (!claim.rowCount) {
      await client.query('ROLLBACK');
      return;
    }
    await client.query(GOOGLE_AUTH_INTENT_SCHEMA);
    await client.query(`UPDATE app_meta SET value = now()::text WHERE key = 'google_auth_intent_v1'`);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/** Adds owner-scoped in-app notifications plus the optional order-update preference column. */
async function applyNotificationsOnce() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const claim = await client.query(
      `INSERT INTO app_meta (key, value)
       VALUES ('notifications_v1', 'pending')
       ON CONFLICT (key) DO NOTHING
       RETURNING key`,
    );
    if (!claim.rowCount) {
      await client.query('ROLLBACK');
      return;
    }
    await client.query(NOTIFICATIONS_SCHEMA);
    await client.query(`UPDATE app_meta SET value = now()::text WHERE key = 'notifications_v1'`);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/** Adds optional, nullable gender and date-of-birth profile fields without touching existing rows. */
async function applyProfileFieldsOnce() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const claim = await client.query(
      `INSERT INTO app_meta (key, value)
       VALUES ('profile_fields_v1', 'pending')
       ON CONFLICT (key) DO NOTHING
       RETURNING key`,
    );
    if (!claim.rowCount) {
      await client.query('ROLLBACK');
      return;
    }
    await client.query(PROFILE_FIELDS_SCHEMA);
    await client.query(`UPDATE app_meta SET value = now()::text WHERE key = 'profile_fields_v1'`);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/** Adds reusable identity-verification challenge, rate-limit, and audit tables. */
async function applyVerificationChallengesOnce() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const claim = await client.query(
      `INSERT INTO app_meta (key, value)
       VALUES ('verification_challenges_v1', 'pending')
       ON CONFLICT (key) DO NOTHING
       RETURNING key`,
    );
    if (!claim.rowCount) {
      await client.query('ROLLBACK');
      return;
    }
    await client.query(VERIFICATION_CHALLENGES_SCHEMA);
    await client.query(`UPDATE app_meta SET value = now()::text WHERE key = 'verification_challenges_v1'`);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/** Adds the explicit verified-authorization state column to verification challenges. */
async function applyVerificationVerifiedStateOnce() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const claim = await client.query(
      `INSERT INTO app_meta (key, value)
       VALUES ('verification_verified_state_v1', 'pending')
       ON CONFLICT (key) DO NOTHING
       RETURNING key`,
    );
    if (!claim.rowCount) {
      await client.query('ROLLBACK');
      return;
    }
    await client.query(VERIFICATION_VERIFIED_STATE_SCHEMA);
    await client.query(`UPDATE app_meta SET value = now()::text WHERE key = 'verification_verified_state_v1'`);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/** Binds verification challenges to the issuing auth_version so security changes invalidate them. */
async function applyVerificationAuthVersionOnce() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const claim = await client.query(
      `INSERT INTO app_meta (key, value)
       VALUES ('verification_auth_version_v1', 'pending')
       ON CONFLICT (key) DO NOTHING
       RETURNING key`,
    );
    if (!claim.rowCount) {
      await client.query('ROLLBACK');
      return;
    }
    await client.query(VERIFICATION_AUTH_VERSION_SCHEMA);
    await client.query(`UPDATE app_meta SET value = now()::text WHERE key = 'verification_auth_version_v1'`);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/** Adds reauthentication-proof storage and email-change audit types for Phase 4 Change Email. */
async function applyChangeEmailOnce() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const claim = await client.query(
      `INSERT INTO app_meta (key, value)
       VALUES ('change_email_v1', 'pending')
       ON CONFLICT (key) DO NOTHING
       RETURNING key`,
    );
    if (!claim.rowCount) {
      await client.query('ROLLBACK');
      return;
    }
    await client.query(CHANGE_EMAIL_SCHEMA);
    await client.query(`UPDATE app_meta SET value = now()::text WHERE key = 'change_email_v1'`);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/** Adds durable reorder idempotency records without touching historical orders. */
async function applyReorderOnce() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const claim = await client.query(
      `INSERT INTO app_meta (key, value)
       VALUES ('reorder_v1', 'pending')
       ON CONFLICT (key) DO NOTHING
       RETURNING key`,
    );
    if (!claim.rowCount) {
      await client.query('ROLLBACK');
      return;
    }
    await client.query(REORDER_SCHEMA);
    await client.query(`UPDATE app_meta SET value = now()::text WHERE key = 'reorder_v1'`);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/** Adds P4C favorites and account accessibility preferences once. */
async function applyFavoritesPreferencesOnce() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const claim = await client.query(
      `INSERT INTO app_meta (key, value)
       VALUES ('favorites_preferences_v1', 'pending')
       ON CONFLICT (key) DO NOTHING
       RETURNING key`,
    );
    if (!claim.rowCount) {
      await client.query('ROLLBACK');
      return;
    }
    await client.query(FAVORITES_PREFERENCES_SCHEMA);
    await client.query(`UPDATE app_meta SET value = now()::text WHERE key = 'favorites_preferences_v1'`);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/** Adds internal refund review records and backfills only verified eligible cancellations. */
async function applyRefundManagementOnce() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const claim = await client.query(
      `INSERT INTO app_meta (key, value)
       VALUES ('refund_management_v1', 'pending')
       ON CONFLICT (key) DO NOTHING
       RETURNING key`,
    );
    if (!claim.rowCount) {
      const stored = await client.query(`SELECT value FROM app_meta WHERE key = 'refund_management_v1'`);
      await client.query('ROLLBACK');
      try {
        return { applied: false, ...JSON.parse(stored.rows[0]?.value ?? '{}') };
      } catch {
        return { applied: false, reviewed: 0, eligible: 0, created: 0, skipped: 0 };
      }
    }
    await client.query(REFUND_MANAGEMENT_SCHEMA);
    const reviewedResult = await client.query(
      `SELECT count(*)::int AS count FROM orders WHERE order_status = 'cancelled'`,
    );
    const eligible = await client.query(
      `SELECT orders.id AS "orderId", requests.id AS "cancellationRequestId",
              attempts.id AS "paymentAttemptId", attempts.payment_method AS "paymentMethod",
              attempts.provider_payment_id AS "providerPaymentId",
              attempts.amount_centavos AS "amountCentavos", attempts.currency
       FROM orders
       JOIN order_cancellation_requests requests ON requests.order_id = orders.id
         AND requests.status = 'approved'
       JOIN payment_attempts attempts ON attempts.order_id = orders.id
         AND attempts.status = 'paid' AND attempts.provider_payment_id IS NOT NULL
       WHERE orders.order_status = 'cancelled'
         AND COALESCE(orders.payment_state, orders.payment_status) = 'paid'
         AND orders.payment_is_demo = false
         AND COALESCE(orders.payment_method_v2, orders.payment_method) IN ('gcash', 'maya')
         AND attempts.amount_centavos = round(orders.order_total * 100)::bigint`,
    );
    let created = 0;
    for (const row of eligible.rows) {
      await client.query(
        `UPDATE order_cancellation_requests
         SET refund_review_status = 'review_required'
         WHERE id = $1 AND refund_review_status <> 'review_required'`,
        [row.cancellationRequestId],
      );
      const inserted = await client.query(
        `INSERT INTO order_refunds
           (public_id, order_id, cancellation_request_id, payment_attempt_id, provider,
            payment_method, provider_payment_id, amount_centavos, currency)
         VALUES ($1, $2, $3, $4, 'paymongo', $5, $6, $7, $8)
         ON CONFLICT (payment_attempt_id) DO NOTHING
         RETURNING id`,
        [
          crypto.randomUUID(), row.orderId, row.cancellationRequestId, row.paymentAttemptId,
          row.paymentMethod, row.providerPaymentId, row.amountCentavos, row.currency,
        ],
      );
      if (!inserted.rowCount) continue;
      created += 1;
      await client.query(
        `INSERT INTO refund_events
           (public_id, refund_id, from_status, to_status, actor_type, idempotency_key, reason)
         VALUES ($1, $2, NULL, 'review_required', 'system', $3, $4)`,
        [
          crypto.randomUUID(), inserted.rows[0].id, crypto.randomUUID(),
          'Refund review opened for a verified paid cancellation.',
        ],
      );
    }
    const reviewed = reviewedResult.rows[0].count;
    const stats = { reviewed, eligible: eligible.rowCount, created, skipped: reviewed - created };
    await client.query(
      `UPDATE app_meta SET value = $2 WHERE key = $1`,
      ['refund_management_v1', JSON.stringify(stats)],
    );
    await client.query('COMMIT');
    return { applied: true, ...stats };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** Adds auditable fulfillment transitions and individually authenticated operators. */
async function applyOrderLifecycleOnce() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const claim = await client.query(
      `INSERT INTO app_meta (key, value)
       VALUES ('order_lifecycle_v1', 'pending')
       ON CONFLICT (key) DO NOTHING
       RETURNING key`,
    );
    if (!claim.rowCount) {
      await client.query('ROLLBACK');
      return;
    }
    await client.query(ORDER_LIFECYCLE_SCHEMA);
    await client.query(`UPDATE app_meta SET value = now()::text WHERE key = 'order_lifecycle_v1'`);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/** Adds nullable image snapshots without rewriting historical order rows. */
async function applyOrderImageSnapshotOnce() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const claim = await client.query(
      `INSERT INTO app_meta (key, value)
       VALUES ('order_image_snapshot_v1', 'pending')
       ON CONFLICT (key) DO NOTHING
       RETURNING key`,
    );
    if (!claim.rowCount) {
      await client.query('ROLLBACK');
      return;
    }
    await client.query(ORDER_IMAGE_SNAPSHOT_SCHEMA);
    await client.query(`UPDATE app_meta SET value = now()::text WHERE key = 'order_image_snapshot_v1'`);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/** Adds the P4B owner-scoped address book without linking mutable rows to orders. */
async function applyAddressBookOnce() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const claim = await client.query(
      `INSERT INTO app_meta (key, value)
       VALUES ('address_book_v1', 'pending')
       ON CONFLICT (key) DO NOTHING
       RETURNING key`,
    );
    if (!claim.rowCount) {
      await client.query('ROLLBACK');
      return;
    }
    await client.query(ADDRESS_BOOK_SCHEMA);
    await client.query(`UPDATE app_meta SET value = now()::text WHERE key = 'address_book_v1'`);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/** Adds the nullable P3 draft-agreement snapshot fields once. */
async function applyOrderAgreementOnce() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const claim = await client.query(
      `INSERT INTO app_meta (key, value)
       VALUES ('order_agreement_v1', 'pending')
       ON CONFLICT (key) DO NOTHING
       RETURNING key`,
    );
    if (!claim.rowCount) {
      await client.query('ROLLBACK');
      return;
    }
    await client.query(ORDER_AGREEMENT_SCHEMA);
    await client.query(`UPDATE app_meta SET value = now()::text WHERE key = 'order_agreement_v1'`);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/** Adds isolated wallet-demo records without changing genuine payment states. */
async function applyWalletDemoOnce() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const claim = await client.query(
      `INSERT INTO app_meta (key, value)
       VALUES ('wallet_demo_v1', 'pending')
       ON CONFLICT (key) DO NOTHING
       RETURNING key`,
    );
    if (!claim.rowCount) {
      await client.query('ROLLBACK');
      return;
    }
    await client.query(WALLET_DEMO_SCHEMA);
    await client.query(`UPDATE app_meta SET value = now()::text WHERE key = 'wallet_demo_v1'`);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/** Adds isolated card-demo records without changing genuine payment states. */
async function applyCardDemoOnce() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const claim = await client.query(
      `INSERT INTO app_meta (key, value)
       VALUES ('card_demo_v1', 'pending')
       ON CONFLICT (key) DO NOTHING
       RETURNING key`,
    );
    if (!claim.rowCount) {
      await client.query('ROLLBACK');
      return;
    }
    await client.query(CARD_DEMO_SCHEMA);
    await client.query(`UPDATE app_meta SET value = now()::text WHERE key = 'card_demo_v1'`);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/** Applies additive NCR and payment tables without changing historical order rows. */
async function applyCheckoutUpgradeOnce() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const claim = await client.query(
      `INSERT INTO app_meta (key, value)
       VALUES ('checkout_upgrade_v1', 'pending')
       ON CONFLICT (key) DO NOTHING
       RETURNING key`,
    );
    if (!claim.rowCount) {
      await client.query('ROLLBACK');
      return;
    }
    await client.query(CHECKOUT_UPGRADE_SCHEMA);
    await client.query(`UPDATE app_meta SET value = now()::text WHERE key = 'checkout_upgrade_v1'`);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/** Applies the additive P2a-1 order schema once in an atomic migration. */
async function applyOrderSchemaOnce() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const claim = await client.query(
      `INSERT INTO app_meta (key, value)
       VALUES ('orders_v1', 'pending')
       ON CONFLICT (key) DO NOTHING
       RETURNING key`,
    );
    if (!claim.rowCount) {
      await client.query('ROLLBACK');
      return;
    }
    await client.query(ORDER_SCHEMA);
    await client.query(`UPDATE app_meta SET value = now()::text WHERE key = 'orders_v1'`);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
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

/**
 * Copies the season tag (e.g. 'halloween') from seed-data.js onto existing products once,
 * so later edits are never overwritten.
 */
async function applySeasonalMenuOnce() {
  const done = await query(`SELECT 1 FROM app_meta WHERE key = 'seasonal_menu_v1'`);
  if (done.rowCount) return;
  for (const p of SEED_PRODUCTS) {
    if (p.season) await query('UPDATE products SET season = $2 WHERE slug = $1', [p.slug, p.season]);
  }
  await query(`INSERT INTO app_meta (key, value) VALUES ('seasonal_menu_v1', now()::text)`);
}

const VOUCHERS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS vouchers (
    code             TEXT PRIMARY KEY CHECK (code ~ '^[A-Z0-9]{3,20}$'),
    title            TEXT NOT NULL CHECK (char_length(title) BETWEEN 3 AND 80),
    description      TEXT NOT NULL CHECK (char_length(description) BETWEEN 3 AND 200),
    discount_type    TEXT NOT NULL CHECK (discount_type IN ('fixed', 'percent')),
    discount_value   NUMERIC(10, 2) NOT NULL CHECK (discount_value > 0),
    max_discount     NUMERIC(10, 2) CHECK (max_discount > 0),
    min_spend        NUMERIC(10, 2) NOT NULL DEFAULT 0 CHECK (min_spend >= 0),
    first_order_only BOOLEAN NOT NULL DEFAULT false,
    required_season  TEXT,
    once_per_user    BOOLEAN NOT NULL DEFAULT true,
    starts_at        TIMESTAMPTZ,
    ends_at          TIMESTAMPTZ,
    is_active        BOOLEAN NOT NULL DEFAULT true,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (discount_type = 'fixed' OR discount_value <= 100)
  );

  CREATE TABLE IF NOT EXISTS voucher_redemptions (
    id           SERIAL PRIMARY KEY,
    voucher_code TEXT NOT NULL REFERENCES vouchers(code),
    user_id      INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    order_id     INT NOT NULL UNIQUE REFERENCES orders(id) ON DELETE CASCADE,
    discount     NUMERIC(12, 2) NOT NULL CHECK (discount > 0),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS voucher_redemptions_user_idx ON voucher_redemptions (user_id, voucher_code);

  ALTER TABLE orders ADD COLUMN IF NOT EXISTS voucher_code TEXT REFERENCES vouchers(code);
  ALTER TABLE orders ADD COLUMN IF NOT EXISTS voucher_discount NUMERIC(12, 2) NOT NULL DEFAULT 0;
  ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_voucher_discount_check;
  ALTER TABLE orders ADD CONSTRAINT orders_voucher_discount_check
    CHECK (voucher_discount >= 0 AND voucher_discount <= merchandise_subtotal
      AND ((voucher_code IS NULL) = (voucher_discount = 0)));

  INSERT INTO vouchers
    (code, title, description, discount_type, discount_value, max_discount, min_spend,
     first_order_only, required_season, once_per_user, ends_at)
  VALUES
    ('WELCOME50', '₱50 off your first order', 'Welcome to Cookie Fluffs! Take ₱50 off your first order of ₱300 or more.',
     'fixed', 50, NULL, 300, true, NULL, true, NULL),
    ('SPOOKY15', '15% off Halloween orders', 'Get 15% off (up to ₱100) when your order includes a Halloween special.',
     'percent', 15, 100, 0, false, 'halloween', false, '2026-11-30 23:59:59+08')
  ON CONFLICT (code) DO NOTHING;
`;

/**
 * Adds vouchers and lets an order total include a voucher discount. The original total rule
 * (order_total = merchandise_subtotal + delivery_fee) has a generated name, so it is found by definition.
 */
async function applyVouchersOnce() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const claim = await client.query(
      `INSERT INTO app_meta (key, value)
       VALUES ('vouchers_v1', 'pending')
       ON CONFLICT (key) DO NOTHING
       RETURNING key`,
    );
    if (!claim.rowCount) {
      await client.query('ROLLBACK');
      return;
    }
    await client.query(VOUCHERS_SCHEMA);
    const oldRule = await client.query(
      `SELECT conname FROM pg_constraint
       WHERE conrelid = 'orders'::regclass AND contype = 'c'
         AND pg_get_constraintdef(oid) = 'CHECK ((order_total = (merchandise_subtotal + delivery_fee)))'`,
    );
    for (const { conname } of oldRule.rows) {
      await client.query(`ALTER TABLE orders DROP CONSTRAINT ${client.escapeIdentifier(conname)}`);
    }
    await client.query(
      `ALTER TABLE orders ADD CONSTRAINT orders_total_with_voucher_check
         CHECK (order_total = merchandise_subtotal - voucher_discount + delivery_fee)`,
    );
    await client.query(`UPDATE app_meta SET value = now()::text WHERE key = 'vouchers_v1'`);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/** Moves Raspberry Red Velvet into the Halloween specials once, on databases that already had it as New. */
async function applySeasonalMenuV2Once() {
  const done = await query(`SELECT 1 FROM app_meta WHERE key = 'seasonal_menu_v2'`);
  if (done.rowCount) return;
  for (const p of SEED_PRODUCTS) {
    if (!p.season) continue;
    await query('UPDATE products SET season = $2, badge = $3, is_new = $4 WHERE slug = $1', [
      p.slug,
      p.season,
      p.badge,
      Boolean(p.isNew),
    ]);
  }
  await query(`INSERT INTO app_meta (key, value) VALUES ('seasonal_menu_v2', now()::text)`);
}
