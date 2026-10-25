/**
 * @file checkout-config.ts
 * @description Validated server-owned checkout capabilities with a fail-closed client fallback.
 */

export interface FulfillmentReadiness {
  enabled: boolean;
  unavailableMessage: string;
}

export interface DeliveryReadiness extends FulfillmentReadiness {
  allowedCityCodes: string[];
}

export interface PickupReadiness extends FulfillmentReadiness {
  location: string;
  hours: string;
}

export interface CheckoutConfig {
  nonProductionDemo: boolean;
  delivery: DeliveryReadiness;
  pickup: PickupReadiness;
  voucher: FulfillmentReadiness;
  agreement: { required: boolean; version: string | null };
  pricing: { currency: 'PHP'; deliveryFee: number; freeDeliveryMinimum: number };
}

const unavailable = 'Checkout options could not be confirmed. Check your connection and try again.';

export const CLOSED_CHECKOUT_CONFIG: CheckoutConfig = {
  nonProductionDemo: false,
  delivery: { enabled: false, unavailableMessage: unavailable, allowedCityCodes: [] },
  pickup: { enabled: false, unavailableMessage: unavailable, location: '', hours: '' },
  voucher: { enabled: false, unavailableMessage: 'Voucher support will be enabled in a future update.' },
  agreement: { required: false, version: null },
  pricing: { currency: 'PHP', deliveryFee: 0, freeDeliveryMinimum: 0 },
};

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function safeText(value: unknown): string {
  return typeof value === 'string' && value.trim().length <= 200 ? value.trim() : '';
}

/** Accepts only a complete, internally consistent public capability response. */
export function normalizeCheckoutConfig(value: unknown): CheckoutConfig {
  const root = object(value);
  const delivery = object(root?.['delivery']);
  const pickup = object(root?.['pickup']);
  const agreement = object(root?.['agreement']);
  const pricing = object(root?.['pricing']);
  const allowedCityCodes = Array.isArray(delivery?.['allowedCityCodes'])
    ? delivery['allowedCityCodes'].filter((code): code is string => typeof code === 'string' && /^\d{10}$/.test(code))
    : [];
  const deliveryEnabled = delivery?.['enabled'] === true && allowedCityCodes.length > 0;
  const pickupLocation = safeText(pickup?.['location']);
  const pickupHours = safeText(pickup?.['hours']);
  const pickupEnabled = pickup?.['enabled'] === true && Boolean(pickupLocation && pickupHours);
  const agreementRequired = agreement?.['required'] === true;
  const agreementVersion = safeText(agreement?.['version']) || null;
  const deliveryFee = pricing?.['deliveryFee'];
  const freeDeliveryMinimum = pricing?.['freeDeliveryMinimum'];
  if (!root || !delivery || !pickup || !agreement || !pricing
    || pricing['currency'] !== 'PHP'
    || typeof deliveryFee !== 'number' || deliveryFee < 0
    || typeof freeDeliveryMinimum !== 'number' || freeDeliveryMinimum < 0
    || (agreementRequired && !agreementVersion)) return CLOSED_CHECKOUT_CONFIG;

  return {
    nonProductionDemo: root['nonProductionDemo'] === true,
    delivery: {
      enabled: deliveryEnabled,
      unavailableMessage: safeText(delivery['unavailableMessage']) || CLOSED_CHECKOUT_CONFIG.delivery.unavailableMessage,
      allowedCityCodes,
    },
    pickup: {
      enabled: pickupEnabled,
      unavailableMessage: safeText(pickup['unavailableMessage']) || CLOSED_CHECKOUT_CONFIG.pickup.unavailableMessage,
      location: pickupLocation,
      hours: pickupHours,
    },
    voucher: CLOSED_CHECKOUT_CONFIG.voucher,
    agreement: { required: agreementRequired, version: agreementVersion },
    pricing: { currency: 'PHP', deliveryFee, freeDeliveryMinimum },
  };
}
