import { Routes } from '@angular/router';

export const routes: Routes = [
  { path: '', redirectTo: 'home', pathMatch: 'full' },
  {
    // Bottom tabs. URLs stay /home, /shop and /cart.
    path: '',
    loadComponent: () => import('./pages/tabs/tabs.page').then((m) => m.TabsPage),
    children: [
      {
        path: 'home',
        title: 'Cookie Fluffs',
        loadComponent: () => import('./pages/home/home.page').then((m) => m.HomePage),
      },
      {
        path: 'shop',
        title: 'All Cookies',
        loadComponent: () => import('./pages/shop/shop.page').then((m) => m.ShopPage),
      },
      {
        path: 'cart',
        title: 'My Cart',
        loadComponent: () => import('./pages/cart/cart.page').then((m) => m.CartPage),
      },
    ],
  },
  {
    path: 'product/:id',
    title: 'Cookie Details',
    loadComponent: () => import('./pages/product-detail/product-detail.page').then((m) => m.ProductDetailPage),
  },
  {
    path: 'box',
    title: 'Build your box',
    loadComponent: () => import('./pages/box-builder/box-builder.page').then((m) => m.BoxBuilderPage),
  },
  {
    path: 'login',
    title: 'Log in',
    loadComponent: () => import('./pages/login/login.page').then((m) => m.LoginPage),
  },
  {
    path: 'terms',
    title: 'Terms of Use',
    loadComponent: () => import('./pages/terms/terms.page').then((m) => m.TermsPage),
  },
  {
    path: 'privacy',
    title: 'Privacy Policy',
    loadComponent: () => import('./pages/privacy/privacy.page').then((m) => m.PrivacyPage),
  },
  {
    path: 'company-history',
    title: 'Our Story',
    loadComponent: () => import('./pages/company-history/company-history.page').then((m) => m.CompanyHistoryPage),
  },
  {
    path: 'about-products',
    title: 'About Our Products',
    loadComponent: () => import('./pages/about-products/about-products.page').then((m) => m.AboutProductsPage),
  },
  {
    path: 'about-app',
    title: 'About the App',
    loadComponent: () => import('./pages/about-app/about-app.page').then((m) => m.AboutAppPage),
  },
  {
    path: 'developers',
    title: 'Developers',
    loadComponent: () => import('./pages/developers/developers.page').then((m) => m.DevelopersPage),
  },
  {
    path: 'contact',
    title: 'Contact Us',
    loadComponent: () => import('./pages/contact/contact.page').then((m) => m.ContactPage),
  },
  { path: '**', redirectTo: 'home' },
];
