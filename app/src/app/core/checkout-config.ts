/**
 * @file checkout-config.ts
 * @description Typed release safeguards for fulfillment options with unconfirmed business details.
 */
import { InjectionToken } from '@angular/core';
import { environment } from '../../environments/environment';

export interface FulfillmentReadiness {
  enabled: boolean;
  unavailableMessage: string;
}

export interface CheckoutConfig {
  nonProductionDemo: boolean;
  delivery: FulfillmentReadiness;
  pickup: FulfillmentReadiness;
  voucher: FulfillmentReadiness;
}

const awaitingDelivery = 'Delivery is unavailable until the approved service area is configured.';
const awaitingPickup = 'Store pickup is unavailable until the pickup address and hours are confirmed.';

/** Production stays closed until real fulfillment details are approved; local demos exercise both paths. */
export function checkoutConfigFor(production: boolean): CheckoutConfig {
  return {
    nonProductionDemo: !production,
    delivery: { enabled: !production, unavailableMessage: awaitingDelivery },
    pickup: { enabled: !production, unavailableMessage: awaitingPickup },
    voucher: { enabled: false, unavailableMessage: 'Voucher support will be enabled in a future update.' },
  };
}

export const DEFAULT_CHECKOUT_CONFIG = checkoutConfigFor(environment.production);

export const CHECKOUT_CONFIG = new InjectionToken<CheckoutConfig>('CHECKOUT_CONFIG', {
  providedIn: 'root',
  factory: () => DEFAULT_CHECKOUT_CONFIG,
});
