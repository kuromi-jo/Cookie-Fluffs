/**
 * @file catalog-snapshot.ts
 * @description Versioned public cookie catalog bundled for read-only offline browsing.
 */
import { Product } from './models';

export const CATALOG_SNAPSHOT_VERSION = 1;

const cookie = (
  id: number,
  slug: string,
  fields: Omit<Product, 'id' | 'slug' | 'imageUrl' | 'isAvailable' | 'isBestSeller' | 'isNew' | 'salePrice' | 'badge'>
    & Partial<Pick<Product, 'isBestSeller' | 'isNew' | 'salePrice' | 'badge'>>,
): Product => ({
  id,
  slug,
  imageUrl: `assets/cookies/${slug}.webp`,
  isAvailable: true,
  isBestSeller: false,
  isNew: false,
  salePrice: null,
  badge: null,
  ...fields,
});

/** Public display snapshot only. Prices and availability must be revalidated by the API before ordering. */
export const BUNDLED_CATALOG: readonly Product[] = Object.freeze([
  cookie(1, 'choco-chip', {
    name: 'Classic Choco Chip',
    tagline: 'Golden, chewy and loaded with melty chocolate chunks',
    description: 'The cookie that started it all: crisp golden edges, a soft brown-butter center and big pools of semi-sweet chocolate in every bite.',
    flavorNotes: 'Brown butter • Dark chocolate', category: 'classic', price: 119, rating: 4.95,
    reviewsCount: 248, calories: 280, allergens: ['Gluten', 'Dairy', 'Eggs'], badge: 'Best Seller', isBestSeller: true,
  }),
  cookie(2, 'choco-lava', {
    name: 'Choco Lava', tagline: 'Deep dark cocoa with a molten fudge center',
    description: 'Our darkest bake. Dutch cocoa dough wrapped around a gooey fudge core, finished with a snowfall of powdered sugar.',
    flavorNotes: 'Dark cocoa • Molten fudge', category: 'indulgent', price: 139, rating: 4.92,
    reviewsCount: 201, calories: 320, allergens: ['Gluten', 'Dairy', 'Eggs'], badge: 'Best Seller', isBestSeller: true,
  }),
  cookie(3, 'red-velvet', {
    name: 'Red Velvet Cream', tagline: 'Velvety cocoa crumb under a swirl of cream cheese frosting',
    description: 'Soft red velvet cookie topped with tangy cream cheese frosting and a dusting of red velvet crumbs.',
    flavorNotes: 'Red velvet • Cream cheese', category: 'indulgent', price: 139, rating: 4.9,
    reviewsCount: 176, calories: 300, allergens: ['Gluten', 'Dairy', 'Eggs'], badge: 'Fan Favorite', isBestSeller: true,
  }),
  cookie(4, 'reeses-peanutbutter', {
    name: "Reese's Peanut Butter", tagline: 'Peanut butter cookie with peanut butter cups and chocolate drizzle',
    description: 'A rich peanut butter base topped with chopped peanut butter cups, a peanut butter glaze and ribbons of milk chocolate.',
    flavorNotes: 'Peanut butter • Milk chocolate', category: 'nutty', price: 149, rating: 4.93,
    reviewsCount: 158, calories: 340, allergens: ['Gluten', 'Dairy', 'Eggs', 'Peanuts'], badge: 'Best Seller', isBestSeller: true,
  }),
  cookie(5, 'choco-caramel', {
    name: 'Choco Caramel Crunch', tagline: 'Salted caramel pool topped with toffee and chocolate bits',
    description: 'A buttery cookie with a salted caramel center, piled with crunchy toffee and chocolate pieces.',
    flavorNotes: 'Salted caramel • Toffee', category: 'nutty', price: 145, rating: 4.88,
    reviewsCount: 132, calories: 330, allergens: ['Gluten', 'Dairy', 'Eggs', 'Tree Nuts'], badge: 'Cozy Fave', isBestSeller: true,
  }),
  cookie(6, 'brookie', {
    name: 'Brookie', tagline: 'Half fudgy brownie, half choco chip cookie',
    description: "Can't decide? Don't. One side is our chewy choco chip cookie, the other is a crackly fudge brownie, baked together.",
    flavorNotes: 'Brownie • Choco chip', category: 'indulgent', price: 139, rating: 4.9,
    reviewsCount: 87, calories: 330, allergens: ['Gluten', 'Dairy', 'Eggs'], badge: 'New', isNew: true,
  }),
  cookie(7, 'cookie-dough', {
    name: 'Cookie Dough Cream', tagline: 'Brown sugar frosting with bites of edible cookie dough',
    description: 'A soft vanilla cookie crowned with brown sugar buttercream, edible cookie dough bites and mini chocolate chips.',
    flavorNotes: 'Cookie dough • Buttercream', category: 'indulgent', price: 149, rating: 4.87,
    reviewsCount: 64, calories: 350, allergens: ['Gluten', 'Dairy', 'Eggs'], badge: 'New', isNew: true,
  }),
  cookie(8, 'mango-pie', {
    name: 'Mango Pie', tagline: 'Flaky lattice cookie with sweet Philippine mango filling',
    description: 'Inspired by the merienda classic: a buttery lattice-top cookie filled with sweet Guimaras mango and a scoop of cream.',
    flavorNotes: 'Mango • Butter crust', category: 'fruity', price: 139, rating: 4.91,
    reviewsCount: 73, calories: 290, allergens: ['Gluten', 'Dairy', 'Eggs'], badge: 'Filipino Fave', isNew: true,
  }),
  cookie(9, 'ube-pandan', {
    name: 'Ube Pandan', tagline: 'Pandan-rimmed cookie with creamy ube frosting',
    description: 'A fragrant pandan cookie edged with ube crumbs and topped with silky ube cream: two Filipino favorites in one bite.',
    flavorNotes: 'Ube • Pandan', category: 'fruity', price: 149, rating: 4.9,
    reviewsCount: 58, calories: 300, allergens: ['Gluten', 'Dairy', 'Eggs'], badge: 'Signature', isNew: true,
  }),
  cookie(10, 'strawberry-crumbs', {
    name: 'Strawberry Crumble', tagline: 'Vanilla cookie with strawberry crumbs and cream glaze',
    description: 'A pillowy vanilla cookie glazed with sweet cream and showered with crunchy freeze-dried strawberry crumbs.',
    flavorNotes: 'Strawberry • Vanilla cream', category: 'fruity', price: 135, rating: 4.86,
    reviewsCount: 69, calories: 280, allergens: ['Gluten', 'Dairy', 'Eggs'], badge: 'Pink Fluff', isNew: true,
  }),
  cookie(11, 'cream-lime', {
    name: 'Key Lime Cream', tagline: 'Graham-rimmed cookie with zesty lime cream',
    description: 'Bright and refreshing: a graham cracker cookie filled with tangy key lime cream, a dollop of whipped cream and a lime twist.',
    flavorNotes: 'Key lime • Graham', category: 'fruity', price: 139, rating: 4.84,
    reviewsCount: 51, calories: 270, allergens: ['Gluten', 'Dairy', 'Eggs'], salePrice: 119,
  }),
  cookie(12, 'oreo-vanilla', {
    name: 'Oreo Cookies & Cream', tagline: 'Vanilla cream frosting packed with crushed Oreos',
    description: 'Soft sugar cookie spread with cookies-and-cream frosting, crushed Oreo pieces and a mini Oreo on top.',
    flavorNotes: 'Oreo • Vanilla cream', category: 'classic', price: 135, rating: 4.89,
    reviewsCount: 112, calories: 310, allergens: ['Gluten', 'Dairy', 'Eggs', 'Soy'], salePrice: 115,
  }),
  cookie(13, 'hershey-choco-vanilla', {
    name: "Hershey's Choco Vanilla", tagline: 'Vanilla dough with Hershey’s chunks and fudge drizzle',
    description: 'A buttery vanilla cookie loaded with Hershey’s milk chocolate pieces and finished with a chocolate fudge drizzle.',
    flavorNotes: 'Milk chocolate • Vanilla', category: 'indulgent', price: 149, rating: 4.85,
    reviewsCount: 77, calories: 330, allergens: ['Gluten', 'Dairy', 'Eggs', 'Soy'], salePrice: 129,
  }),
  cookie(14, 'gingerbread', {
    name: 'Gingerbread Snap', tagline: 'Warm ginger, cinnamon and molasses with a sugar crackle',
    description: 'Lightly spiced with ginger, cinnamon and a touch of molasses, rolled in sugar for a crackly top. Less sweet, all cozy.',
    flavorNotes: 'Ginger • Cinnamon', category: 'dietary', price: 109, rating: 4.8,
    reviewsCount: 46, calories: 210, allergens: ['Gluten', 'Eggs'], badge: 'Lighter Bite', salePrice: 89,
  }),
  cookie(15, 'sugar', {
    name: 'Classic Sugar', tagline: 'Simple, soft and buttery with a light sugar sparkle',
    description: 'Our lightest bake: a soft, buttery vanilla sugar cookie with a delicate sugar crust. Perfect with coffee.',
    flavorNotes: 'Butter • Vanilla', category: 'dietary', price: 99, rating: 4.82,
    reviewsCount: 95, calories: 190, allergens: ['Gluten', 'Dairy', 'Eggs'], badge: 'Lighter Bite',
  }),
  cookie(16, 'brown-sugar', {
    name: 'Brown Sugar Swirl', tagline: 'Cinnamon brown sugar frosting piped in a soft swirl',
    description: 'A tender cinnamon cookie topped with a swirl of brown sugar buttercream, like a cinnamon roll in cookie form.',
    flavorNotes: 'Brown sugar • Cinnamon', category: 'classic', price: 129, rating: 4.86,
    reviewsCount: 88, calories: 300, allergens: ['Gluten', 'Dairy', 'Eggs'],
  }),
  cookie(17, 'brownie', {
    name: 'Fudge Brownie', tagline: 'Crackly top, dense fudgy middle, pure chocolate',
    description: 'All the fudgy, crackle-topped goodness of a brownie in cookie form. Made with 70% dark chocolate.',
    flavorNotes: '70% dark • Fudge', category: 'indulgent', price: 129, rating: 4.88,
    reviewsCount: 104, calories: 310, allergens: ['Gluten', 'Dairy', 'Eggs'],
  }),
  cookie(18, 'oreo-choco', {
    name: 'Oreo Choco Swirl', tagline: 'Dark cocoa cookie with a cookie butter swirl and mini Oreo',
    description: 'A dark chocolate cookie piped with a cookie butter spiral and crowned with a mini Oreo.',
    flavorNotes: 'Cocoa • Cookie butter', category: 'indulgent', price: 145, rating: 4.87,
    reviewsCount: 81, calories: 340, allergens: ['Gluten', 'Dairy', 'Eggs', 'Soy'],
  }),
]);
