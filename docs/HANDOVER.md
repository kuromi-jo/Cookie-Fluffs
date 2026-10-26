# Cookie Fluffs — Developer Handover

> Teammate onboarding + Phase 6 (Account/Notifications) baseline. No secrets, tokens, OTPs, or
> customer PII appear here. Read `AGENTS.md` for the project rules and `HANDOFF.md` for the
> checklist and "Last session" note.

## 1. Architecture and important directories

- **`app/`** — Ionic 9 + Angular 22 (standalone components, signals, zoneless). Dev server on port 4200.
  The app never talks to the database; it calls `/api/...`, proxied in dev by `app/proxy.conf.json`.
  - `src/app/app.routes.ts` — routes. `src/app/core/*.service.ts` — API clients + state.
  - `src/app/core/models.ts` — types, prices, pack options. `src/theme/variables.scss`, `src/global.scss` — design tokens.
  - `src/app/pages/*` — screens. `src/app/components/*` — shared components (verification + Google reauth modals, etc.).
- **`server/`** — Node 20+ ESM, Express 4, `pg` on Neon Postgres. API on port 3000; routes in `server/src/routes/`.
  - `src/db.js` — connection pool, `SCHEMA`, and idempotent migrations. `src/seed-data.js` — menu seed.
  - `src/auth.js` — JWT sign/verify + `requireAuth` (auth_version enforcement). `src/runtime-config.js` — env validation + feature flags.

## 2. Backend vs frontend responsibilities

- **Server is authoritative** for prices, discounts, fees, totals, order state, payment reconciliation,
  and all account-security decisions. Never trust client numbers.
- **Client** renders state, collects input, and calls the API. Secrets, hashing, and verification live server-side only.

## 3. Authentication and verification security flows

- **Sessions**: JWT carries `auth_version`; `requireAuth` rejects any token whose `auth_version` ≠ the
  live `users.auth_version` (and requires `account_status='active'`). Password/phone/email/set-password
  changes bump `auth_version`, invalidating all other sessions; the acting client receives a fresh token.
- **Dual-proof model for sensitive changes**: a short-lived, single-use, **purpose-bound** reauth proof
  (`reauth_authorizations`) is minted only after a verified current-password check or Google reauth, and a
  separate verification challenge (email OTP) proves control of the target. The final change consumes
  **both** atomically in one transaction (`consumeReauth` + `consumeVerified` + the account UPDATE).
- **Operations**: `change_phone`, `change_email`, `set_password` (and `change_password` via the existing
  current-password flow). Each proof/challenge is bound to user + operation + auth_version; cross-operation
  use and replay are rejected. `change_email` sends the OTP to the NEW email; `set_password` sends to the
  current registered email and requires the account to be passwordless.
- **Google reauth**: reuses `google_auth_nonces` but the nonce hash is purpose-tagged so a login/signup
  nonce can never satisfy reauth (and vice versa). The token subject must already be linked to the
  authenticated user; reauth never links, creates, or logs in a new account.
- **Delivery gating**: real email OTP delivery is off unless `VERIFICATION_DELIVERY_ENABLED=true` with valid
  Brevo settings; the challenge engine still works (hashing/expiry/rate limits) via the pepper for tests.
  Password recovery is off unless `PASSWORD_RECOVERY_ENABLED=true`.

## 4. Database migration procedure

- Migrations are **idempotent** `apply…Once()` functions in `server/src/db.js`, each claiming a key in
  `app_meta` and registered in `REQUIRED_MIGRATION_KEYS`. Schema changes are additive
  (`CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`, CHECK re-adds). Never drop or truncate data.
- Apply via the advisory-locked `migrateWithLock()` against a **verified** target (identity-check the DB
  first). API startup never mutates the schema.
- The isolated local sandbox is currently at **24 migration markers**. Integration tests run against a
  disposable, template0-cloned database — never the persistent sandbox.

## 5. Notifications (Account/Notifications Phase 6) — producers, endpoints, preferences

- **Table**: `notifications` (owner-scoped, `public_id`, category, event_type, title, body, link_path,
  dedupe_key, read_at) with a partial unread index. `user_preferences.notify_order_updates` gates optional
  order-progress items.
- **Service** (`server/src/notification-service.js`): `insertNotification` runs inside the parent business
  transaction wrapped in a SAVEPOINT (a notification failure never aborts the order/payment/security op);
  deduped on `(user_id, dedupe_key)`; optional `order` category respects the preference, while `payment`,
  `security`, and `order_cancelled` are always essential. Plus `listNotifications` (keyset pagination),
  `unreadCount`, `markNotificationRead`, `markAllNotificationsRead`.
- **Producers**: order lifecycle (placed/confirmed/preparing/ready/out_for_delivery/completed/cancelled),
  payment paid/failed, refund approved/rejected, password_changed, and security_alert (phone/email/set-password).
- **Endpoints** (`/api/notifications`, all authenticated, owner-scoped): `GET /` (paginated `?limit&cursor`),
  `GET /unread-count`, `POST /read-all`, `POST /:id/read`.
- **Preferences** (`/api/auth/me/preferences` via `routes/preferences.js`): `reduceMotion`, `largerText`,
  and optional `notifyOrderUpdates`. Frontend: `notification.service.ts` (unread badge with offline
  staleness, optimistic read, account-switch clearing), Notification Center page, and the settings toggle.

## 6. Local development and test commands

- First-time setup: `npm run setup` (installs root, server, app).
- Run both dev servers: `npm run dev` (API :3000, app :4200). Or individually: `npm run api`, `npm run app`.
  - The Angular dev server port follows `PORT`; if a shell exports `PORT=3000` it will mis-bind — pin
    `PORT=4200 npm run app` (the sandbox tooling runs it this way so ngrok → :4200 works).
- Frontend: `npm --prefix app test`, `npm --prefix app run lint`, `npm --prefix app run build`.
- Backend: `cd server && node --test src/<file>.test.js`. Disposable-PostgreSQL integration tests run only
  when `TEST_DATABASE_URL` (and matching `DATABASE_URL`) point at an explicitly named local test/sandbox DB.
- Current automated status (local sandbox): **340 backend tests pass**, **295 frontend tests pass**, app
  lint + production build pass. (Production build emits a known, pre-existing checkout SCSS budget warning.)

## 7. Verification status: automated vs real acceptance

- **Automated (green)**: all backend + frontend suites above, including verification engine, reauth,
  Change Phone/Email, Set Password (incl. cross-operation, replay, stale auth_version, atomic rollback).
- **Real supervised acceptance (done)**: Change Phone, Change Email, and Set Password each completed once
  through the browser against the sandbox with real Brevo OTP delivery, then delivery was restored to off.
- **Pending manual checks (NOT yet accepted)**:
  - Email + password login after Set Password; Google login still works; old-session (lower auth_version) rejected.
  - Google reauth button visual alignment at 320/375/395px and desktop.
  - Android P6 device acceptance (fresh install, airplane-mode relaunch, reconnection refresh).

## 8. Phase 6 scope reconciliation

- **"Account/Notifications Phase 6"** (this effort) = in-app notifications + account settings. It is
  **implemented and automated-tested**; remaining options are in-app polish (deep-link/mark-read-on-open,
  per-category toggles) and, as a larger separate subsystem, **push/real-time delivery (NOT built)**.
- **"Android P6" in the checklist** is different: platform work (`P6A` resilient catalog, `P6B` fulfillment
  readiness + deployment hardening). Those are largely `[x]`; the open item is **P6A device acceptance**.

## 9. Known limitations

- No push/real-time notification delivery (in-app only; poll/refresh-based).
- Brevo sender is a `@gmail.com` single sender — fine for sandbox, DMARC-fragile for production.
- Google Identity Services allows one `initialize()` per page load; the reauth modal resets GIS per open to
  support cancel→reopen, but unrelated GIS COOP console advisories persist (benign).
- PayMongo remains test-mode; provider refund execution (P5R-B) and promo codes are deferred.
- Placeholder content remains: shop contact info, company story, cookie descriptions/prices.

## 10. Remaining tasks (recommended order)

1. Manual P5 browser checks (login with new password, Google login, old-session rejection, button alignment).
2. Stage B: notification/settings in-app polish — Notification Center deep-link + mark-read-on-open across
   all event types; optional per-category preferences (small additive `user_preferences` column if added).
3. Android P6A device acceptance on a physical device.
4. Optional Stage C: push delivery (new subscription/token table → migration, delivery service, service
   worker / FCM, consent UI) — scope and design separately.
5. Replace placeholder content; Custom Cookie Builder (core plan feature) if in scope.
6. Commit the uncommitted work (section 11) under teammate GitHub accounts.

## 11. Git working-tree status (requires review before committing)

- Branch `main`; latest commit `9b523f4` (server runtime/deployment hardening). The entire account-security,
  verification, Google-auth, and notification system below is **uncommitted** and must be reviewed + committed
  by a teammate under their own account (project rule: no AI co-author/"generated by" lines; one commit per
  logical unit).
- **Tracked modifications** include: `app/angular.json` (ngrok `allowedHosts` + disabled Angular build cache),
  `app/src/app/app.component.*`, `app.routes.ts`, `core/auth.service.ts` + spec, `core/models.ts`,
  `core/preference.service.ts`, `pages/login/*`, `pages/profile/*`, `pages/settings/*`, `pages/orders/*`,
  `pages/order-confirmation/*`, `components/privacy-content.component.ts`, `icons.ts`, `global.scss`,
  `index.html`, `server/.env.example`, and this `HANDOFF.md`.
- **Untracked new files** (not yet added) include, server-side: `account-security-service.js`,
  `change-phone-service.js`, `change-email-service.js`, `set-password-service.js`, `reauth-service.js`,
  `verification-service.js`, `verification-email.js`, `google-auth-service.js`, `google-reauth-service.js`,
  `notification-service.js`, `password-recovery-service.js`, `recovery-email.js`, `reorder-service.js`,
  `cart-service.js`, `routes/verification.js`, `routes/notifications.js`, and their `*.test.js` files;
  client-side: `core/verification.service.ts`, `core/notification.service.ts`, `core/google-auth.service.ts`,
  `components/verification-modal.*`, `components/google-reauth-modal.*`, `components/password-requirements.*`,
  `pages/notifications/`, `pages/security/`, `pages/forgot-password/`, `pages/reset-password/`,
  `login.page.spec.ts`, `app.component.spec.ts`; and `app/android/.../GoogleAuthPlugin.java`.
- **Do not** discard untracked files — they are the implementation. `app/angular.json` and unrelated files
  must be preserved. No commit/push/deploy/APK without explicit approval.

## 12. Safe environment setup (no secrets)

- Copy `server/.env.example` to `server/.env` and obtain the real values privately from the team lead
  (Neon `DATABASE_URL`, `JWT_SECRET`, PayMongo test keys, Brevo API key + verified sender, and the
  `*_PEPPER` secrets). Keep `VERIFICATION_DELIVERY_ENABLED=false` and `PASSWORD_RECOVERY_ENABLED=false`
  unless running a supervised delivery test. Never commit `server/.env`. New variables go in `.env.example`.
- The isolated sandbox used during development runs a local Postgres on a non-default loopback port with a
  pinned private env file (referenced by name only here — its values are not reproduced).
