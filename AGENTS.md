# Instructions for AI coding assistants: Cookie Fluffs

This file is self-contained. Do not read README.md or HANDOFF.md unless the task says so. Open HANDOFF.md only
at the end, to tick the checklist and rewrite "Last session" in 3 lines or fewer.

## 1. What this project is (stay aligned with it)
Cookie Fluffs is a mobile-first cookie shop app for online ordering and sales tracking. It is a school project
(IT 005 Integrative Programming and Technologies, TIP Quezon City, IT31S6), so it must stay simple to demo,
explain and run with `npm run dev`. Customers are people in the Philippines ordering cookies on a phone.
Currency is Philippine peso, shown as `₱` with `toLocaleString('en-PH')`.

Already built and working (the 60% build). Never break these:
splash screen, home with Sweet deals / Best sellers / Fresh from the oven, side menu with user photo, name and
phone, login and signup with optional photo, All Cookies tab (search, categories, sorting, roulette), product
detail with pack choice, mix-and-match box builder, cart with tick boxes and totals saved in Neon, contact form,
info pages (Company History, About Our Products, About the App, Developers).

Build only what the current task asks. Do not add features, screens, libraries or "improvements" that were not
requested. If the task is ambiguous or conflicts with these rules, stop and ask one short question.

## 2. Stack and layout
- `app/`: Ionic 9 + Angular 22. Standalone components, signals, zoneless. Dev server on port 4200.
- `server/`: Node 20+ ESM, Express 4, `pg` on Neon Postgres. API on port 3000, routes in `server/src/routes/`.
- The app never talks to the database; it calls `/api/...` (proxied in dev by `app/proxy.conf.json`).
- Schema lives in `server/src/db.js` (`SCHEMA` string, idempotent). Seed menu in `server/src/seed-data.js`.
- Key files: `app/src/app/app.routes.ts`, `core/models.ts` (types, prices, packs), `core/*.service.ts`,
  `core/ui.service.ts` (toasts), `core/api-error.ts`, `pages/*`, `components/*`, `server/src/auth.js`.

## 3. Design system (use it, do not reinvent it)
Light, warm, bakery look. There is no dark mode; do not add one.

Tokens (in `app/src/theme/variables.scss`; always use the CSS variables, never hard-code new colors):
- Cocoa text and buttons: `--cf-choco #4a3024`, `--cf-choco-btn #523628`, `--cf-choco-medium`, `--cf-choco-light`.
- Surfaces: `--cf-canvas #fff5f7` (page), `--cf-pink-soft #fce7f3`, `--cf-pink-card`, white cards.
- Borders and accents: `--cf-pink-border #fbcfe8`, `--cf-pink-accent #f472b6`, `--cf-pink-deep #be185d`.
- Status: Ionic `success` green, `warning` gold, `danger #d6336c`.
- Type: Fraunces (`--cf-font-display`) for headings and prices of note, Plus Jakarta Sans (`--cf-font-body`) for the rest.
- Radii: 12px small, 20px cards, 28px large, 999px for buttons and chips.

Shared classes in `app/src/global.scss`, reuse before writing new CSS: `.cf-card`, `.cf-eyebrow`, `.cf-section-title`,
`.cf-muted`, `.cf-price`, `.cf-page` (8px 20px 32px), `.cf-hero-band`, `.cf-chip`, `ion-button.cf-btn-lg` (52px),
`.cf-input` (pill fields, 58px high), `ion-modal.cf-sheet`, `ion-alert.cf-alert-confirm`, `.cf-rise` (entrance
animation), `.cf-toast` / `.cf-toast-error`. Headers use `class="cf-header"`; titles use `ion-title.cf-title`.

Flat UI: no drop shadows. Separate surfaces with color and thin borders. The only allowed `box-shadow` is a
zero-blur spread ring used as a focus indicator (see `.cf-input.has-focus`).

Icons: SVG only. Ionicons, or custom `cf-*` icons in `brand-icons.ts`. Register every icon in `icons.ts`.
No emojis anywhere (UI, docs, logs, commits). Decorative icons get `aria-hidden="true"`.

## 4. UI and UX rules (apply to every screen you build or change)
Layout and navigation
- Design for a phone first (360 to 412 px wide). It must also look right inside the 412px desktop phone frame.
- New pages are standalone components lazy-loaded in `app.routes.ts`, with `ion-header.cf-header`, a back button or
  menu button, and content inside `ion-content` using `.cf-page`.
- Primary actions sit where the thumb is: bottom `ion-footer` or a full-width `cf-btn-lg` button. One primary
  action per screen; secondary actions are outline or text buttons.
- Guests can browse. Anything that needs an account sends the user to `/login` with `returnUrl`, then back.

States (every screen that loads or changes data needs all of these)
- Loading: `ion-spinner name="crescent"` or a skeleton in the same shape as the content.
- Empty: a short friendly message, a matching icon, and one button to the next sensible action.
- Error: plain language that says what happened and what to do next. Never show ports, file names, "server",
  `.env`, or status codes to users. Keep the user's input; never clear a form because of an error.
- Success: a toast through `UiService`, or a clear confirmation screen for big actions (like an order).

Forms
- Use `ion-input` with `class="cf-input"`, floating labels, the correct `type`, `inputmode` and `autocomplete`.
- Validate on blur and on submit. Show the message directly under the field it belongs to, not only in a banner.
  Each message names the problem and the fix ("Password needs at least 8 characters").
- Required fields are marked; optional ones say "(optional)". Show passwords with the existing toggle.
- Disable the submit button only while submitting, and show a spinner inside it.

Destructive actions
- Always confirm with `ion-alert.cf-alert-confirm`: the safe choice is the filled button on top, the risky one a
  quiet text button below (copy the pattern in `cart.page.ts`).

Content and tone
- Warm, short, friendly, in plain English. Sentence case. Buttons are verbs ("Add to cart", "Place order").
- Prices always show `₱`. Quantities and totals update instantly and match what the server returns.

Accessibility
- Touch targets at least 44x44 px. Text contrast at least WCAG AA on its background.
- Icon-only buttons need `aria-label`. Errors use `role="alert"`. Inputs have real labels.
- Everything works with a keyboard. Respect `prefers-reduced-motion`.

## 5. Code rules
- Every file starts with a short `@file` and `@description` doc comment. Signals for state. Follow neighbors' style.
- Prices, discounts, fees and totals are computed on the server from the database. Never trust client numbers.
- `BOX_DISCOUNTS` (server `routes/cart.js`) and the box and pack options in `app/src/app/core/models.ts` must
  stay in sync.
- Schema changes: append idempotent statements to `SCHEMA` in `db.js` (`CREATE TABLE IF NOT EXISTS`,
  `ADD COLUMN IF NOT EXISTS`). Never drop or truncate data.
- Validate all input on the server. Use parameterized queries only. Return `{ message }` errors in plain language.
- Do not install dependencies without asking. Prefer what is already in `package.json`.

## 6. Safety
- Never open, print, copy or commit `server/.env`. New variables go in `server/.env.example`.
- Do not run `git push`, `git reset --hard`, force commands, or anything that changes the live database other
  than starting the server.
- Do not commit unless the task says so. When asked: one commit per task, imperative message, no
  "Co-authored-by" or "generated by" lines.

## 7. Working efficiently
- Never read or search `node_modules/`, `.angular/`, `package-lock.json`, or `app/src/assets/`.
- Use `rg` to locate code, then open only the files the task needs. Do not scan the whole repo.
- One task per session. If a task touches more than 3 files, reply first with a plan (files, data shape, API
  shape, screens) and wait for "go".
- Keep diffs small. No drive-by refactors, renames or reformatting of code you were not asked to change.
- Reuse existing services, components and styles before writing new ones.

## 8. Definition of done
1. `npm --prefix app run lint` and `npm --prefix app run build` pass (when the app was touched).
2. `node --check` passes on every changed server file. For new endpoints, include working `curl` examples.
3. Nothing from section 1's "never break" list was changed by accident.
4. If you could not run a check, say so. Do not claim it passed.
5. Final reply, at most 8 lines: what changed, files touched, how it was verified, a short "Manual test"
   list of steps the user can click through, and anything left undone. Do not paste whole files.
6. Tick the HANDOFF.md checklist item and update "Last session".