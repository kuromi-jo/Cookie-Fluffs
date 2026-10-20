/**
 * @file models.ts
 * @description Shapes of the data the Cookie Fluffs API sends back.
 */

export type CookieCategory = 'classic' | 'nutty' | 'fruity' | 'indulgent' | 'dietary';

export interface Product {
  id: number;
  slug: string;
  name: string;
  tagline: string;
  description: string;
  flavorNotes: string;
  category: CookieCategory;
  price: number;
  rating: number;
  reviewsCount: number;
  calories: number;
  allergens: string[];
  badge: string | null;
  imageUrl: string;
  isAvailable: boolean;
  isBestSeller: boolean;
  isNew: boolean;
  /** Promo price; null when the cookie is not on promo. */
  salePrice: number | null;
}

/** Home-screen collections, also used as the Shop tab's ?show= filter. */
export type Collection = 'best' | 'new' | 'promo';

export const COLLECTIONS: Record<Collection, { title: string; subtitle: string; icon: string }> = {
  promo: { title: 'Sweet deals', subtitle: 'Limited-time promo prices', icon: 'pricetag-outline' },
  best: { title: 'Best sellers', subtitle: 'Our most-loved bakes', icon: 'trophy-outline' },
  new: { title: 'Fresh from the oven', subtitle: 'New on the menu', icon: 'sparkles-outline' },
};

export function inCollection(p: Product, c: Collection): boolean {
  return c === 'best' ? p.isBestSeller : c === 'new' ? p.isNew : p.salePrice !== null;
}

/** The price the customer actually pays. */
export function effectivePrice(p: Product): number {
  return p.salePrice ?? p.price;
}

/** Whole-number discount, e.g. 15 for 15% off. */
export function discountPercent(p: Product): number {
  return p.salePrice === null ? 0 : Math.round((1 - p.salePrice / p.price) * 100);
}

export interface User {
  id: number;
  fullName: string;
  email: string;
  phone: string;
  avatar: string | null;
  createdAt: string;
}

export interface AuthResponse {
  token: string;
  user: User;
}

export interface CartItem {
  productId: number;
  quantity: number;
  name: string;
  tagline: string;
  imageUrl: string;
  category: CookieCategory;
  /** price per cookie after any promo */
  price: number;
  regularPrice: number;
  lineTotal: number;
  /** ticked in the cart; only ticked items count toward checkout */
  selected: boolean;
}

/** A mix-and-match box in the cart. */
export interface CartBox {
  id: number;
  size: BoxSize;
  quantity: number;
  selected: boolean;
  /** one entry per slot, in slot order */
  cookies: { productId: number; name: string; imageUrl: string; price: number }[];
  /** sum of the cookies before the box discount */
  regularPrice: number;
  discountPercent: number;
  /** price of one box after the discount */
  price: number;
  lineTotal: number;
}

export interface Cart {
  items: CartItem[];
  boxes: CartBox[];
  /** every item in the cart, a box counts as one (badge) */
  itemCount: number;
  /** ticked items only (checkout) */
  selectedCount: number;
  subtotal: number;
  deliveryFee: number;
  freeDeliveryMin: number;
  total: number;
}

export const EMPTY_CART: Cart = {
  items: [],
  boxes: [],
  itemCount: 0,
  selectedCount: 0,
  subtotal: 0,
  deliveryFee: 0,
  freeDeliveryMin: 500,
  total: 0,
};

/* ------------------------------------------------------------------ packs */

export type BoxSize = 4 | 6 | 12;
export type PackSize = 1 | BoxSize;

export interface PackOption {
  size: PackSize;
  label: string;
  hint: string;
  /** mix-and-match discount; must match BOX_DISCOUNTS in server/src/routes/cart.js */
  discountPercent: number;
  /** slot layout of the open box: columns × rows */
  cols: number;
  rows: number;
}

export const PACK_OPTIONS: PackOption[] = [
  { size: 1, label: 'Single', hint: 'Just this cookie', discountPercent: 0, cols: 1, rows: 1 },
  { size: 4, label: 'Box of 4', hint: 'Mix & match 4', discountPercent: 5, cols: 2, rows: 2 },
  { size: 6, label: 'Box of 6', hint: 'Mix & match 6', discountPercent: 10, cols: 3, rows: 2 },
  { size: 12, label: 'Box of 12', hint: 'Party box', discountPercent: 15, cols: 4, rows: 3 },
];

export function packOption(size: number): PackOption | undefined {
  return PACK_OPTIONS.find((o) => o.size === size);
}

/** Box price for a list of cookies, same rounding as the server. */
export function boxPrice(cookies: Product[], size: BoxSize): { regular: number; price: number } {
  const regular = cookies.reduce((sum, p) => sum + effectivePrice(p), 0);
  const discount = packOption(size)?.discountPercent ?? 0;
  return { regular, price: Math.round(regular * (1 - discount / 100)) };
}

/** Small 240px version of a cookie picture, for boxes, lists and the cart. */
export function thumbUrl(imageUrl: string): string {
  return imageUrl.startsWith('assets/cookies/') ? imageUrl.replace('assets/cookies/', 'assets/cookies/thumbs/') : imageUrl;
}

/** Category chips. Icons are SVGs: Ionicons plus our own cf-* icons (see brand-icons.ts). */
export const CATEGORIES: { id: CookieCategory | 'all'; label: string; icon: string }[] = [
  { id: 'all', label: 'All', icon: 'grid-outline' },
  { id: 'classic', label: 'Classic', icon: 'cf-cookie' },
  { id: 'indulgent', label: 'Indulgent', icon: 'cf-chocolate' },
  { id: 'fruity', label: 'Fruity', icon: 'cf-strawberry' },
  { id: 'nutty', label: 'Nutty', icon: 'cf-nut' },
  { id: 'dietary', label: 'Lighter', icon: 'leaf-outline' },
];
