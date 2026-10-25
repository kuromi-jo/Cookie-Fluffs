/**
 * @file fulfillment-config.js
 * @description Fail-closed business readiness configuration for checkout fulfillment and agreements.
 */
import { getNcrGeography } from './geography.js';
import { DELIVERY_FEE_CENTAVOS, FREE_DELIVERY_MIN_CENTAVOS, centavosToPesos } from './pricing.js';

const DELIVERY_UNAVAILABLE = 'Delivery is unavailable until an approved service area is configured.';
const PICKUP_UNAVAILABLE = 'Store pickup is unavailable until the pickup location and hours are confirmed.';
const PUBLIC_TEXT_RE = /^[^\u0000-\u001f\u007f]{3,200}$/;
const cityCodes = new Set(getNcrGeography().cities.map((city) => city.code));

function enabledFlag(value) {
  return typeof value === 'string' && value.trim().toLowerCase() === 'true';
}

function publicText(value) {
  const text = typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
  return PUBLIC_TEXT_RE.test(text) ? text : '';
}

function approvedCityCodes(value) {
  if (typeof value !== 'string') return [];
  const codes = [...new Set(value.split(',').map((code) => code.trim()).filter(Boolean))];
  return codes.length && codes.every((code) => cityCodes.has(code)) ? codes : [];
}

/** Builds one immutable, public-safe fulfillment capability document from server configuration. */
export function fulfillmentConfig(env = process.env) {
  const deliveryRequested = enabledFlag(env.FULFILLMENT_DELIVERY_ENABLED);
  const allowedCityCodes = approvedCityCodes(env.FULFILLMENT_DELIVERY_CITY_CODES);
  const pickupRequested = enabledFlag(env.FULFILLMENT_PICKUP_ENABLED);
  const pickupLocation = publicText(env.FULFILLMENT_PICKUP_LOCATION);
  const pickupHours = publicText(env.FULFILLMENT_PICKUP_HOURS);
  const deliveryEnabled = deliveryRequested && allowedCityCodes.length > 0;
  const pickupEnabled = pickupRequested && Boolean(pickupLocation && pickupHours);
  const agreementRequired = enabledFlag(env.ORDER_AGREEMENT_REQUIRED);
  const agreementVersion = agreementRequired ? publicText(env.ORDER_AGREEMENT_VERSION) : '';
  const appEnv = typeof env.APP_ENV === 'string' ? env.APP_ENV.trim().toLowerCase() : '';

  return Object.freeze({
    nonProductionDemo: appEnv === 'demo' || appEnv === 'test',
    delivery: Object.freeze({
      enabled: deliveryEnabled,
      unavailableMessage: deliveryEnabled ? '' : DELIVERY_UNAVAILABLE,
      allowedCityCodes: Object.freeze(deliveryEnabled ? allowedCityCodes : []),
    }),
    pickup: Object.freeze({
      enabled: pickupEnabled,
      unavailableMessage: pickupEnabled ? '' : PICKUP_UNAVAILABLE,
      location: pickupEnabled ? pickupLocation : '',
      hours: pickupEnabled ? pickupHours : '',
    }),
    agreement: Object.freeze({
      required: agreementRequired,
      version: agreementVersion || null,
    }),
    pricing: Object.freeze({
      currency: 'PHP',
      deliveryFee: centavosToPesos(DELIVERY_FEE_CENTAVOS),
      freeDeliveryMinimum: centavosToPesos(FREE_DELIVERY_MIN_CENTAVOS),
    }),
  });
}

/** Rejects disabled or uncovered fulfillment before any order database work begins. */
export function fulfillmentError(config, order) {
  if (order.fulfillmentMethod === 'pickup') {
    return config.pickup.enabled ? null : config.pickup.unavailableMessage;
  }
  if (!config.delivery.enabled) return config.delivery.unavailableMessage;
  if (!config.delivery.allowedCityCodes.includes(order.deliveryAddress?.cityCode)) {
    return 'Delivery is unavailable for the selected city. Choose an approved delivery address.';
  }
  return null;
}
