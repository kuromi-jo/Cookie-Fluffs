/**
 * @file pricing.test.js
 * @description Exact pricing tests for carts and checkout.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyDiscount,
  centavosToMoney,
  deliveryFeeCentavos,
  moneyToCentavos,
  priceBox,
  priceSingle,
} from './pricing.js';

test('converts exact money values without floating-point parsing', () => {
  assert.equal(moneyToCentavos('499.99'), 49_999);
  assert.equal(moneyToCentavos('500.00'), 50_000);
  assert.equal(centavosToMoney(49_999), '499.99');
});

test('prices single quantities and promotional prices exactly', () => {
  assert.deepEqual(priceSingle({ price: '120.00', salePrice: null, quantity: 2 }), {
    regularUnitCentavos: 12_000,
    unitCentavos: 12_000,
    promotionDiscountCentavos: 0,
    packDiscountCentavos: 0,
    lineTotalCentavos: 24_000,
  });
  assert.equal(priceSingle({ price: '120.00', salePrice: '99.99', quantity: 3 }).lineTotalCentavos, 29_997);
});

test('prices promotional mix-and-match boxes with exact pack discounts', () => {
  const priced = priceBox({
    size: 4,
    quantity: 2,
    components: [
      { price: '100.00', salePrice: '90.00' },
      { price: '100.00', salePrice: null },
      { price: '100.00', salePrice: null },
      { price: '100.00', salePrice: null },
    ],
  });
  assert.equal(priced.regularUnitCentavos, 40_000);
  assert.equal(priced.effectiveUnitBeforePackCentavos, 39_000);
  assert.equal(priced.unitCentavos, 37_050);
  assert.equal(priced.promotionDiscountCentavos, 2_000);
  assert.equal(priced.packDiscountCentavos, 3_900);
  assert.equal(priced.lineTotalCentavos, 74_100);
});

test('preserves the approved 5, 10, and 15 percent pack discounts', () => {
  const component = { price: '100.00', salePrice: null };
  assert.equal(priceBox({ components: Array(4).fill(component), size: 4, quantity: 1 }).unitCentavos, 38_000);
  assert.equal(priceBox({ components: Array(6).fill(component), size: 6, quantity: 1 }).unitCentavos, 54_000);
  assert.equal(priceBox({ components: Array(12).fill(component), size: 12, quantity: 1 }).unitCentavos, 102_000);
});

test('rounds percentage discounts half up to one centavo', () => {
  assert.equal(applyDiscount(10_001, 5), 9_501);
  assert.equal(applyDiscount(9_999, 10), 8_999);
});

test('applies delivery thresholds to selected merchandise only', () => {
  assert.equal(deliveryFeeCentavos(49_999, 'delivery'), 4_900);
  assert.equal(deliveryFeeCentavos(50_000, 'delivery'), 0);
  assert.equal(deliveryFeeCentavos(49_999, 'pickup'), 0);
  assert.equal(deliveryFeeCentavos(0, 'delivery'), 0);
});
