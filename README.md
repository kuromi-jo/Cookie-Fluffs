# Cookie Fluffs: 60% Project Progress

**A Mobile-Based Cookie Shop Management Application for Online Ordering and Sales Tracking**
IT 005 · Integrative Programming and Technologies · IT31S6 · TIP Quezon City

Built with **Ionic Framework 9 + Angular 22** (mobile app), a **Node.js + Express** REST API, and a **Neon PostgreSQL** cloud database.

```
┌──────────────────────┐   HTTP /api   ┌──────────────────────┐    SQL (TLS)    ┌──────────────┐
│ Ionic + Angular app  │ ────────────▶ │ Express REST API     │ ──────────────▶ │ Neon Postgres│
│ app/  (port 4200)    │ ◀──────────── │ server/  (port 3000) │ ◀────────────── │ (cloud)      │
└──────────────────────┘     JSON      └──────────────────────┘                 └──────────────┘
```

---

## Quiz 5.2 checklist: where each requirement lives

| Requirement | Where in the app | Source |
|---|---|---|
| **App Icon** | Browser tab icon, "Install app" icon, About the App page | `app/src/assets/icon/`, `app/src/manifest.webmanifest` |
| **1. Splash Screen** | Animated logo screen when the app opens (menu loads behind it) | `app/src/app/components/splash.component.ts` |
| **2. Main/Home Screen** (products shown immediately) | Home tab: products from Neon appear the moment the splash ends, grouped into **Sweet deals** (promos), **Best sellers** and **Fresh from the oven** (new) | `app/src/app/pages/home/` |
| **3. Side Menu** | Menu button, top-left | `app/src/app/app.component.html` |
| ↳ User Image | Profile photo (tap it to change), or initials if none | |
| ↳ User Name | From the logged-in account | |
| ↳ Contact / Phone Number | From the logged-in account | |
| ↳ Company History · About Our Products · Cart · About the App · Developers · Contact Us | Menu links | `app/src/app/pages/*` |
| **4. Login Page** | Log in / Sign up | `app/src/app/pages/login/` |
| **5. Product List** (database) | **All Cookies** tab: all 18 cookies (real product cut-out photos) from **Neon**, with search, categories and sorting | `server/src/seed-data.js`, `server/src/routes/products.js` |
| **6. Shopping Cart** (add + view) | Cart button opens **Single / Box of 4 / 6 / 12**. Boxes open the **box builder**: an open pink box where tapped cookies drop into place. Cart tab: singles and boxes, tick / untick (saved in Neon), Select all, change qty, swipe to remove; totals count only ticked items. Checkout guides customers through Information, Fulfillment, Payment and Review before submitting one server-priced order; cash works without provider credentials, test-mode PayMongo wallets appear only when configured, and an explicitly enabled nonproduction card demo accepts supplied synthetic values without processing money. | `app/src/app/pages/cart/`, `app/src/app/pages/checkout/`, `server/src/routes/cart.js`, `server/src/routes/orders.js` |

Extras: mix-and-match boxes with 5 / 10 / 15% off, "Surprise me" box filler, flat no-shadow design, bottom tabs (Home · All Cookies · Cart), promo prices, sorting, search, category filters, product detail page, free-delivery progress bar, pull-to-refresh, a contact form saved to the database, and a login that persists after refresh.

---

## How to run

### First time only

1. Install **Node.js 20 or newer** (you have v24).
2. Put your Neon connection string in **`server/.env`** (already done on this PC):
   ```
   DATABASE_URL=postgresql://...your Neon string...
   ```
   Optional test-mode PayMongo settings are documented with blank values in **`server/.env.example`**. Never use a live key for this project.
3. Install everything (root, server and app). Run this in the `Cookie-Fluffs` folder:
   ```bash
   npm run setup
   ```

### Every time

In the `Cookie-Fluffs` folder:

```bash
npm run dev
```

This starts **both** the API (port 3000) and the Ionic app (port 4200) and opens **http://localhost:4200** in your browser. Stop with **Ctrl + C**.

The first time the API connects, it creates the tables in Neon and loads the 18-cookie menu automatically.

> Prefer two terminals? Run `npm run api` in one and `npm run app` in the other.
> Prefer the Ionic CLI? Start the API with `npm run api`, then `cd app` and `ionic serve`.

### Viewing it as a phone

* **Normal browser window:** on a laptop screen the app automatically shows inside a phone frame.
* **True mobile view:** press **F12** in Chrome, click the *Toggle device toolbar* (phone) icon, pick e.g. *iPhone 12 Pro*, and refresh.
* **Show the app icon:** in Chrome, click the *Install* icon in the address bar (or ⋮ → *Cast, save and share* → *Install page as app*). Cookie Fluffs then opens in its own window with its own icon.

---

## Suggested screen-recording flow (about 3 minutes)

1. **App icon:** show the browser tab icon, or the installed app icon on the desktop/taskbar.
2. **Splash screen:** refresh the page to show the animated splash.
3. **Home screen:** products load immediately. Scroll, use **search** ("choco"), tap a **category** chip.
4. **Side menu as a guest:** open the menu and point out the menu items.
5. **Add to cart as a guest:** the app asks you to log in → **Log in**.
6. **Sign up:** enter your first name, last name, email, phone and password → you are logged in and back on Home.
7. **Side menu again:** now shows **your photo, name and phone number**.
8. **Product list → cart:** on Home, scroll the Sweet deals / Best sellers / New sections and tap **See all**; open the **All Cookies** tab, search and sort. Tap the cart button on a cookie and choose **Single** (quantity 2, **Add**). Tap it again and choose **Box of 6** → **Build your box**: tap cookies to drop them into the pink box, tap one in the box to take it out, try **Surprise me** and switching between 4 / 6 / 12, then **Add box to cart**.
9. **Cart and checkout:** show the box next to the single cookies. Untick an item and watch the totals and Checkout count change; then open Checkout and continue through Information, Fulfillment, Payment and Review. Point out that vouchers are clearly unavailable until backend support exists, place the cash order, then refresh the confirmation to show that it reloads the existing order. In an explicitly enabled nonproduction environment, the supplied synthetic Visa and Mastercard values demonstrate approved and declined card outcomes without a real charge.
10. **Prove it's in the database:** refresh the browser. You're still logged in, and unselected cart entries are still there.
    *Optional:* open the Neon dashboard → **Tables** → `cart_items` / `users` to show the rows.
11. **Menu pages:** Company History, About Our Products, About the App, Developers, Contact Us (send a message).
12. **Log out** from the side menu.

---

## Project structure

```
Cookie-Fluffs/
├── package.json            ← "npm run dev" runs API + app together
├── server/                 ← Express REST API
│   ├── .env                ← DATABASE_URL + JWT_SECRET (private, never share)
│   └── src/
│       ├── index.js        ← starts the API, creates tables, seeds the menu
│       ├── db.js           ← Neon connection + table definitions
│       ├── auth.js         ← login tokens (JWT)
│       ├── seed-data.js    ← the 18 Cookie Fluffs products
│       └── routes/         ← products, auth, cart, orders, geography, payments, contact
└── app/                    ← Ionic + Angular mobile app
    ├── proxy.conf.json     ← forwards /api calls to the server
    └── src/
        ├── theme/variables.scss   ← brand colors (cocoa + bakery pink)
        ├── global.scss            ← fonts (Fraunces + Plus Jakarta Sans), shared styles, phone frame
        ├── assets/brand/          ← cookie logo (SVG)
        ├── assets/icon/           ← app icons (PNG)
        └── app/
            ├── app.component.*    ← side menu + splash
            ├── icons.ts           ← registers every SVG icon (Ionicons + brand icons)
            ├── brand-icons.ts     ← custom cookie / chocolate / strawberry / acorn icons
            ├── core/              ← services: auth, products, cart, orders, toasts
            ├── components/        ← splash, product card, avatar, location picker
            └── pages/             ← tabs, home, shop, product-detail, box-builder, cart, login,
                                      checkout, order-confirmation, company-history, about-products,
                                      about-app, developers, contact
```

### API endpoints

| Method | Endpoint | What it does |
|---|---|---|
| GET | `/api/health` | Checks the API and database connection |
| GET | `/api/products?category=&search=&collection=` | Product list (`collection` = best, new or promo) |
| GET | `/api/products/:id` | One product |
| POST | `/api/auth/signup` | Create account (password is hashed with bcrypt) |
| POST | `/api/auth/login` | Log in, returns a token |
| GET / PUT | `/api/auth/me` | Read / update profile (name, phone, photo) |
| GET | `/api/cart` | View cart with totals |
| POST | `/api/cart` | Add `{ productId, quantity }` |
| PATCH | `/api/cart/:productId` | Set `quantity` and/or tick / untick (`selected`) |
| PATCH | `/api/cart` | Select all / none `{ selected }` |
| POST | `/api/cart/boxes` | Add a box `{ size: 4 | 6 | 12, productIds: [...] }` (one id per spot) |
| PATCH / DELETE | `/api/cart/boxes/:boxId` | Box `quantity` / `selected`, or remove it |
| DELETE | `/api/cart/:productId` · `/api/cart` | Remove one item · empty cart |
| POST | `/api/orders` | Place one server-priced delivery or pickup order from selected cart lines |
| GET | `/api/orders/:id` | Read one order confirmation owned by the logged-in customer |
| POST | `/api/orders/:id/payment-session` | Create or recover the owned order's test Hosted Checkout session |
| POST | `/api/orders/:id/demo-card` | Run an allowlisted, nonproduction card-demo scenario for an owned demo order |
| GET | `/api/geography/ncr` | Versioned NCR PSGC cities and barangays used by checkout |
| GET | `/api/payments/config` | Customer-safe list of enabled test payment methods |
| POST | `/api/webhooks/paymongo` | Verify and reconcile signed PayMongo test payment events |
| POST | `/api/contact` | Save a Contact Us message |

### Database tables (Neon)

`users` · `products` · `cart_items` · `cart_boxes` + `cart_box_items` · `orders` + `order_items` + `order_box_items` · `payment_attempts` + `payment_webhook_events` · `demo_payment_attempts` · `contact_messages` · `app_meta` (records one-time data migrations)

---

## Placeholder content to personalize

* **Shop phone / email / address / hours:** `app/src/app/pages/contact/contact.page.ts` (the `shop` object). Production checkout keeps delivery and pickup disabled until approved service-area and pickup details are set in `app/src/app/core/checkout-config.ts`; local development enables both only as a clearly labelled class-project demo.
* **Company story and timeline:** `app/src/app/pages/company-history/company-history.page.ts`
* **Team roles:** `app/src/app/pages/developers/developers.page.ts`
* **Product photos:** the cookie PNGs in the project folder, converted to light WebP files in `app/src/assets/cookies/` (and `thumbs/` for small sizes). To add a cookie: put `<slug>.png` in the project folder, convert it to `app/src/assets/cookies/<slug>.webp`, and add it to `server/src/seed-data.js`.
* **Cookie descriptions:** placeholder copy written from each photo in `server/src/seed-data.js`; edit freely.

---

## Troubleshooting

| Problem | Fix |
|---|---|
| "Cannot reach the Cookie Fluffs server" | The API isn't running. Use `npm run dev` (not just the app). |
| "The database is not connected yet" | Check `DATABASE_URL` in `server/.env` (one line, no quotes). |
| `Port 3000/4200 is already in use` | Close the other terminal that is still running the app, or restart the PC. |
| Products load but look old | Pull down on the Home screen to refresh. |
