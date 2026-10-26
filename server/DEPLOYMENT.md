<!--
  @file DEPLOYMENT.md
  @description Deployment and rollback checklist for the Cookie Fluffs Express API.
-->
# Cookie Fluffs API deployment

Use Node.js 22 LTS. Run `npm ci` in `server/`; this API has no compile step. A release runs migrations as a separate, one-off job with `npm run migrate`, then starts with `npm start`. Never run both migration jobs concurrently. The migration command uses a PostgreSQL advisory lock and exits nonzero if validation, migration, or schema readiness fails.

## Required configuration

- `APP_ENV`: `demo`, `test`, or `production`. Production also requires `NODE_ENV=production`.
- `NODE_ENV`, `PORT`, `DATABASE_URL`, and a unique `JWT_SECRET` of at least 32 characters.
- `CORS_ALLOWED_ORIGINS`: comma-separated exact origins. Production origins must use HTTPS. Include `https://localhost` for a Capacitor Android build that calls this API.
- `ORDER_AGREEMENT_REQUIRED`: explicit `true` or `false`. When true, set `ORDER_AGREEMENT_VERSION` to the approved version; production rejects draft versions.
- `FULFILLMENT_DELIVERY_ENABLED` and `FULFILLMENT_PICKUP_ENABLED`: explicit booleans. Enabled delivery also needs valid `FULFILLMENT_DELIVERY_CITY_CODES`. Enabled pickup needs approved public `FULFILLMENT_PICKUP_LOCATION` and `FULFILLMENT_PICKUP_HOURS`.
- `CARD_DEMO_ENABLED` and `WALLET_DEMO_ENABLED`: explicit booleans; both must be false in production.
- `PASSWORD_RECOVERY_ENABLED`: defaults to `false`. Enabling it also requires an exact HTTPS `PASSWORD_RECOVERY_ORIGIN`, a strong `PASSWORD_RESET_TOKEN_PEPPER`, and server-only `BREVO_API_KEY`, `BREVO_SENDER_EMAIL`, and `BREVO_SENDER_NAME`. The sender must be approved and verified before activation.
- `GOOGLE_AUTH_ENABLED`: defaults to `false`. Enabling it requires the web OAuth client ID in `GOOGLE_WEB_CLIENT_ID` and a strong server-only `GOOGLE_AUTH_NONCE_PEPPER`. Neither value is an OAuth client secret; no Google client secret belongs in this application.

PayMongo Test Mode additionally uses `APP_PUBLIC_URL`, `PAYMONGO_SECRET_KEY`, `PAYMONGO_PUBLIC_KEY`, `PAYMONGO_WEBHOOK_SECRET`, and `PAYMONGO_ENABLED_METHODS`. Do not configure live keys for this project. Never place secrets in source control or Android assets.

Password recovery remains unavailable unless every recovery setting validates at startup. Reset links are built only from `PASSWORD_RECOVERY_ORIGIN`; they are never derived from request headers. Keep all Brevo and token-pepper values out of frontend builds and logs.

Google authentication remains unavailable until `google_auth_v1` is migrated and the web and Android OAuth clients are verified in Google Cloud. The server accepts only Google ID tokens issued for the configured web client ID. Android must register package `ph.cookiefluffs.app` with the debug/release signing certificate fingerprints; web GIS must list each exact HTTPS or loopback JavaScript origin. Never configure a client secret in Angular or Android.

## Google authentication migration checkpoint

Do not run this against a persistent database without a verified backup and target-identity review. For the approved loopback sandbox, the explicit command is run from `server/` only after separate migration authorization:

```sh
node --env-file=/private/tmp/cookie-fluffs-paymongo-sandbox.env src/migrate.js
```

The additive `google_auth_v1` migration makes `users.password_hash` nullable for Google-only accounts and adds one-time nonce/challenge, stable-subject identity, and sanitized event tables. Existing password hashes and accounts are not rewritten. A failed migration rolls back transactionally. After a successful migration, application rollback keeps the additive schema; database rollback requires the verified pre-migration backup. Manual table removal is unsafe once any Google-only account exists.

## Password recovery API

Recovery is public by design but rate limited and returns the same accepted response for known and unknown accounts. The configured recovery origin must also appear in `CORS_ALLOWED_ORIGINS`.

```sh
curl https://api.example.test/api/auth/recovery-config
curl -X POST https://api.example.test/api/auth/forgot-password \
  -H 'Content-Type: application/json' -d '{"email":"customer@example.test"}'
curl -X POST https://api.example.test/api/auth/reset-password \
  -H 'Content-Type: application/json' \
  -d '{"selector":"00000000-0000-4000-8000-000000000000","token":"REDACTED_RESET_TOKEN","newPassword":"REDACTED_NEW_PASSWORD"}'
```

## HTTPS and health checks

Terminate HTTPS at the hosting platform or trusted reverse proxy and forward requests to the configured `PORT`. Preserve request bodies; `/api/webhooks/paymongo` verifies the raw signed payload. Configure the platform liveness path as `/api/health/live` and readiness path as `/api/health/ready`. `/api/health` remains a readiness-compatible endpoint. Health responses intentionally contain no database details.

```sh
curl --fail https://api.example.test/api/health/live
curl --fail https://api.example.test/api/health/ready
```

## Release checklist

1. Back up the target PostgreSQL database and record the current application revision.
2. Validate that the intended database and HTTPS/CORS origins are selected without printing their values.
3. Run one `npm run migrate` job and require exit code 0.
4. Start the API and require readiness HTTP 200 before sending traffic.
5. Verify authentication, catalog, fulfillment configuration, and an unsigned webhook rejection without creating a payment.

## Rollback

Stop traffic to the failed release, restore the previous application revision and its environment, and restart only after readiness succeeds. Migrations are additive and are not automatically reversed. If a migration itself caused failure, keep the API offline and restore the pre-migration database backup after review; do not drop columns or tables manually.
