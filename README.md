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
| **4. Login Page** | Log in / Sign up (with optional profile photo) | `app/src/app/pages/login/` |
| **5. Product List** (database) | **All Cookies** tab: all 18 cookies (real product cut-out photos) from **Neon**, with search, categories and sorting | `server/src/seed-data.js`, `server/src/routes/products.js` |
| **6. Shopping Cart** (add + view) | Cart button opens **Single / Box of 4 / 6 / 12**. Boxes open the **box builder**: an open pink box where tapped cookies drop into place. Cart tab: singles and boxes, tick / untick (saved in Neon), Select all, change qty, swipe to remove; totals count only ticked items | `app/src/app/pages/cart/`, `server/src/routes/cart.js` |

Extras: mix-and-match boxes with 5 / 10 / 15% off, "Surprise me" box filler, flat no-shadow design, bottom tabs (Home · All Cookies · Cart), promo prices, sorting, search, category filters, product detail page, free-delivery progress bar, pull-to-refresh, a contact form saved to the database, and a login that persists after refresh.

---

## How to run

### First time only

1. Install **Node.js 20 or newer** (you have v24).
2. Put your Neon connection string in **`server/.env`** (already done on this PC):
   ```
   DATABASE_URL=postgresql://...your Neon string...
   ```
3. Install everything (root, server and app). Run this in the `COOKIE FLUFFS` folder:
   ```bash
   npm run setup
   ```

### Every time

In the `COOKIE FLUFFS` folder:

```bash
npm run dev
```

This starts **both** the API (port 3000) and the Ionic app (port 4200) and opens **http://localhost:4200** in your browser. Stop with **Ctrl + C**.

The first time the API connects, it creates the tables in Neon and loads the 12-cookie menu automatically.

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
6. **Sign up:** add a profile photo, name, email, phone, password → you are logged in and back on Home.
7. **Side menu again:** now shows **your photo, name and phone number**.
8. **Product list → cart:** on Home, scroll the Sweet deals / Best sellers / New sections and tap **See all**; open the **All Cookies** tab, search and sort. Tap the cart button on a cookie and choose **Single** (quantity 2, **Add**). Tap it again and choose **Box of 6** → **Build your box**: tap cookies to drop them into the pink box, tap one in the box to take it out, try **Surprise me** and switching between 4 / 6 / 12, then **Add box to cart**.
9. **Cart:** show the box (mini pink box with its cookies, discount and price) next to the single cookies. Untick an item and watch the totals and Checkout count change; use **Select all**; change quantities, swipe one left to delete. Tap **Clear** to show the confirm dialog (Keep items is the highlighted choice).
10. **Prove it's in the database:** refresh the browser. You're still logged in and the cart is still there (it comes back from Neon).
    *Optional:* open the Neon dashboard → **Tables** → `cart_items` / `users` to show the rows.
11. **Menu pages:** Company History, About Our Products, About the App, Developers, Contact Us (send a message).
12. **Log out** from the side menu.

---

## Project structure

```
COOKIE FLUFFS/
├── package.json            ← "npm run dev" runs API + app together
├── server/                 ← Express REST API
│   ├── .env                ← DATABASE_URL + JWT_SECRET (private, never share)
│   └── src/
│       ├── index.js        ← starts the API, creates tables, seeds the menu
│       ├── db.js           ← Neon connection + table definitions
│       ├── auth.js         ← login tokens (JWT)
│       ├── seed-data.js    ← the 18 Cookie Fluffs products
│       └── routes/         ← products, auth, cart, contact
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
            ├── core/              ← services: auth, products, cart, toasts
            ├── components/        ← splash, product card, avatar
            └── pages/             ← tabs, home, shop, product-detail, box-builder, cart, login,
                                      company-history, about-products,
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
| POST | `/api/contact` | Save a Contact Us message |

### Database tables (Neon)

`users` · `products` · `cart_items` · `cart_boxes` + `cart_box_items` · `contact_messages` · `app_meta` (records one-time data migrations)

---

## Placeholder content to personalize

* **Shop phone / email / address / hours:** `app/src/app/pages/contact/contact.page.ts` (the `shop` object)
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
