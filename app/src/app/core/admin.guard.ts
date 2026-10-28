/**
 * @file admin.guard.ts
 * @description Route guards for the superadmin: only the owner can open /admin,
 * and the owner lands on the dashboard instead of the shop Home (unless they chose "View the shop").
 */
import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { AuthService } from './auth.service';
import { adminShopView } from './admin.service';

export const superAdminGuard: CanActivateFn = () => {
  const auth = inject(AuthService);
  const router = inject(Router);
  if (auth.isSuperAdmin()) return true;
  return auth.isLoggedIn() ? router.parseUrl('/home') : router.createUrlTree(['/login'], { queryParams: { returnUrl: '/admin' } });
};

export const shopHomeGuard: CanActivateFn = () => {
  const auth = inject(AuthService);
  return auth.isSuperAdmin() && !adminShopView() ? inject(Router).parseUrl('/admin') : true;
};
