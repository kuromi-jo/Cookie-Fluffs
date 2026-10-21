/**
 * @file pricing.js
 * @description Exact centavo pricing shared by carts and order creation.
 */

export const DELIVERY_FEE_CENTAVOS = 4_900;
export const FREE_DELIVERY_MIN_CENTAVOS = 50_000;
export const BOX_DISCOUNTS = Object.freeze({ 4: 5, 6: 10, 12: 15 });

/** Converts a PostgreSQL NUMERIC money value to integer centavos without floating-point parsing. */
export function moneyToCentavos(value) {
  const text = typeof value === 'number' ? value.toFixed(2) : String(value);
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(text);
  if (!match) throw new TypeError(`Invalid money value: ${text}`);
  const centavos = Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'));
  if (!Number.isSafeInteger(centavos)) throw new RangeError('Money value is too large.');
  return centavos;
}

/** Formats integer centavos for a NUMERIC database column. */
export function centavosToMoney(centavos) {
  if (!Number.isSafeInteger(centavos) || centavos < 0) throw new TypeError('Centavos must be a non-negative integer.');
  return `${Math.floor(centavos / 100)}.${String(centavos % 100).padStart(2, '0')}`;
}

/** Converts integer centavos to the API's existing peso number shape for display only. */
export function centavosToPesos(centavos) {
  return centavos / 100;
}

/** Applies a whole-number percentage and rounds half up to the nearest centavo. */
export function applyDiscount(centavos, discountPercent) {
  if (!Number.isSafeInteger(centavos) || centavos < 0) throw new TypeError('Centavos must be a non-negative integer.');
  if (!Number.isInteger(discountPercent) || discountPercent < 0 || discountPercent > 100) {
    throw new TypeError('Discount must be a whole percentage from 0 to 100.');
  }
  return Math.floor((centavos * (100 - discountPercent) + 50) / 100);
}

export function priceSingle({ price, salePrice, quantity }) {
  const regularUnitCentavos = moneyToCentavos(price);
  const unitCentavos = salePrice === null || salePrice === undefined
    ? regularUnitCentavos
    : moneyToCentavos(salePrice);
  const lineTotalCentavos = unitCentavos * quantity;
  return {
    regularUnitCentavos,
    unitCentavos,
    promotionDiscountCentavos: (regularUnitCentavos - unitCentavos) * quantity,
    packDiscountCentavos: 0,
    lineTotalCentavos,
  };
}

export function priceBox({ components, size, quantity }) {
  const discountPercent = BOX_DISCOUNTS[size];
  if (discountPercent === undefined) throw new TypeError('Boxes come in 4, 6 or 12.');
  const componentPrices = components.map((component) => priceSingle({ ...component, quantity: 1 }));
  const regularUnitCentavos = componentPrices.reduce((sum, component) => sum + component.regularUnitCentavos, 0);
  const effectiveUnitBeforePackCentavos = componentPrices.reduce((sum, component) => sum + component.unitCentavos, 0);
  const unitCentavos = applyDiscount(effectiveUnitBeforePackCentavos, discountPercent);
  return {
    componentPrices,
    discountPercent,
    regularUnitCentavos,
    effectiveUnitBeforePackCentavos,
    unitCentavos,
    promotionDiscountCentavos: (regularUnitCentavos - effectiveUnitBeforePackCentavos) * quantity,
    packDiscountCentavos: (effectiveUnitBeforePackCentavos - unitCentavos) * quantity,
    lineTotalCentavos: unitCentavos * quantity,
  };
}

export function deliveryFeeCentavos(merchandiseSubtotalCentavos, fulfillmentMethod) {
  if (fulfillmentMethod === 'pickup' || merchandiseSubtotalCentavos === 0) return 0;
  return merchandiseSubtotalCentavos >= FREE_DELIVERY_MIN_CENTAVOS ? 0 : DELIVERY_FEE_CENTAVOS;
}
