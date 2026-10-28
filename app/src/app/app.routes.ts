/**
 * @file app.routes.ts
 * @description Lazy customer routes within the persistent Cookie Fluffs navigation shell.
 */
import { Routes } from '@angular/router';
import { shopHomeGuard, superAdminGuard } from './core/admin.guard';

export const routes: Routes = [
  {
    path: 'admin',
    title: 'Admin dashboard',
    canActivate: [superAdminGuard],
    loadComponent: () => import('./pages/admin/admin.page').then((m) => m.AdminPage),
  },
  { path: '', redirectTo: 'home', pathMatch: 'full' },
  {
    // Customer shell. Existing URLs stay unchanged while the five-tab bar remains available.
    path: '',
    loadComponent: () => import('./pages/tabs/tabs.page').then((m) => m.TabsPage),
    children: [
      {
        path: 'home',
        title: 'Cookie Fluffs',
        canActivate: [shopHomeGuard],
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
      {
        path: 'product/:id',
        title: 'Cookie Details',
        loadComponent: () => import('./pages/product-detail/product-detail.page').then((m) => m.ProductDetailPage),
      },
      {
        path: 'profile/favorites',
        title: 'My Favorites',
        loadComponent: () => import('./pages/favorites/favorites.page').then((m) => m.FavoritesPage),
      },
      {
        path: 'profile/vouchers',
        title: 'My Vouchers',
        loadComponent: () => import('./pages/vouchers/vouchers.page').then((m) => m.VouchersPage),
      },
      {
        path: 'profile/addresses/new',
        title: 'Add Address',
        loadComponent: () => import('./pages/address-editor/address-editor.page').then((m) => m.AddressEditorPage),
      },
      {
        path: 'profile/addresses/:id/edit',
        title: 'Edit Address',
        loadComponent: () => import('./pages/address-editor/address-editor.page').then((m) => m.AddressEditorPage),
      },
      {
        path: 'profile/addresses',
        title: 'My Addresses',
        loadComponent: () => import('./pages/addresses/addresses.page').then((m) => m.AddressesPage),
      },
      {
        path: 'profile/settings',
        title: 'App Settings',
        loadComponent: () => import('./pages/settings/settings.page').then((m) => m.SettingsPage),
      },
      {
        path: 'profile/security',
        title: 'Privacy & Security',
        loadComponent: () => import('./pages/security/security.page').then((m) => m.SecurityPage),
      },
      {
        path: 'profile',
        title: 'My Profile',
        loadComponent: () => import('./pages/profile/profile.page').then((m) => m.ProfilePage),
      },
      {
        path: 'orders/:id/receipt',
        title: 'Receipt',
        loadComponent: () => import('./pages/receipt/receipt.page').then((m) => m.ReceiptPage),
      },
      {
        path: 'orders/:id',
        title: 'Order details',
        loadComponent: () =>
          import('./pages/order-confirmation/order-confirmation.page').then((m) => m.OrderConfirmationPage),
      },
      {
        path: 'orders',
        title: 'My Orders',
        loadComponent: () => import('./pages/orders/orders.page').then((m) => m.OrdersPage),
      },
      {
        path: 'notifications',
        title: 'Notifications',
        loadComponent: () => import('./pages/notifications/notifications.page').then((m) => m.NotificationsPage),
      },
      {
        path: 'help/faq',
        title: 'Frequently Asked Questions',
        loadComponent: () => import('./pages/faq/faq.page').then((m) => m.FaqPage),
      },
      {
        path: 'help',
        title: 'Help & Support',
        loadComponent: () => import('./pages/help/help.page').then((m) => m.HelpPage),
      },
    ],
  },
  {
    path: 'box',
    title: 'Build your box',
    loadComponent: () => import('./pages/box-builder/box-builder.page').then((m) => m.BoxBuilderPage),
  },
  {
    path: 'checkout',
    title: 'Checkout',
    loadComponent: () => import('./pages/checkout/checkout.page').then((m) => m.CheckoutPage),
  },
  {
    path: 'order/:id',
    title: 'Order confirmation',
    loadComponent: () =>
      import('./pages/order-confirmation/order-confirmation.page').then((m) => m.OrderConfirmationPage),
  },
  {
    path: 'payment-authorization',
    title: 'Secure payment',
    loadComponent: () =>
      import('./pages/payment-authorization/payment-authorization.page').then((m) => m.PaymentAuthorizationPage),
  },
  {
    path: 'payment-authorization/:id',
    title: 'Secure payment',
    loadComponent: () =>
      import('./pages/payment-authorization/payment-authorization.page').then((m) => m.PaymentAuthorizationPage),
  },
  {
    path: 'login',
    title: 'Log in',
    loadComponent: () => import('./pages/login/login.page').then((m) => m.LoginPage),
  },
  {
    path: 'forgot-password',
    title: 'Forgot password',
    loadComponent: () =>
      import('./pages/forgot-password/forgot-password.page').then((m) => m.ForgotPasswordPage),
  },
  {
    path: 'reset-password',
    title: 'Reset password',
    loadComponent: () =>
      import('./pages/reset-password/reset-password.page').then((m) => m.ResetPasswordPage),
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
