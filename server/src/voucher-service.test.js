/**
 * @file voucher-service.test.js
 * @description Voucher code normalization, exact discounts and rule checks without a database.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateVoucher, voucherDiscountCentavos } from './voucher-service.js';
import { normalizeVoucherCode, validateOrderRequest } from './order-validation.js';

const welcome = {
  code: 'WELCOME50', discountType: 'fixed', discountValue: '50.00', maxDiscount: null, minSpend: '300.00',
  firstOrderOnly: true, requiredSeason: null, oncePerUser: true, startsAt: null, endsAt: null, isActive: true,
};
const spooky = {
  code: 'SPOOKY15', discountType: 'percent', discountValue: '15.00', maxDiscount: '100.00', minSpend: '0.00',
  firstOrderOnly: false, requiredSeason: 'halloween', oncePerUser: false, startsAt: null,
  endsAt: '2026-11-30T15:59:59Z', isActive: true,
};

/** Fake query: answers the voucher lookup and the "earlier order" / "already used" checks. */
function fakeDb(voucher, { earlierOrder = false, used = false } = {}) {
  return async (sql) => {
    if (sql.includes('FROM vouchers')) return { rows: voucher ? [voucher] : [], rowCount: voucher ? 1 : 0 };
    if (sql.includes('voucher_redemptions')) return { rows: [], rowCount: used ? 1 : 0 };
    if (sql.includes('FROM orders')) return { rows: [], rowCount: earlierOrder ? 1 : 0 };
    throw new Error(`Unexpected query: ${sql}`);
  };
}

test('normalizes typed codes and rejects malformed ones', () => {
  assert.equal(normalizeVoucherCode('  welcome50 '), 'WELCOME50');
  assert.equal(normalizeVoucherCode(''), null);
  assert.equal(normalizeVoucherCode(undefined), null);
  assert.equal(normalizeVoucherCode('no spaces!'), '');
  assert.equal(normalizeVoucherCode(50), '');
});

test('fixed and percent discounts are exact centavos, capped, and never exceed the subtotal', () => {
  assert.equal(voucherDiscountCentavos(welcome, 39_700), 5_000);
  assert.equal(voucherDiscountCentavos(spooky, 39_700), 5_955);
  assert.equal(voucherDiscountCentavos(spooky, 71_400), 10_000);
  assert.equal(voucherDiscountCentavos(spooky, 333), 50);
  assert.equal(voucherDiscountCentavos(welcome, 3_000), 3_000);
});

test('checkout validation keeps voucher-free requests unchanged and flags bad codes', () => {
  const base = {
    idempotencyKey: '0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d', fulfillmentMethod: 'pickup', paymentMethod: 'cash_on_pickup',
    schedulingMode: 'asap', contactName: 'Ana Reyes', contactPhone: '09181234567', notes: '',
  };
  const plain = validateOrderRequest(base, { agreementRequired: false });
  assert.equal('voucherCode' in plain.value, false);
  assert.equal(validateOrderRequest({ ...base, voucherCode: 'spooky15' }, { agreementRequired: false }).value.voucherCode, 'SPOOKY15');
  assert.ok(validateOrderRequest({ ...base, voucherCode: '%%' }, { agreementRequired: false }).errors.voucherCode);
});

test('enforces minimum spend, season, first order, single use and expiry with plain reasons', async () => {
  const halloween = new Set(['halloween']);
  const now = new Date('2026-10-27T00:00:00Z');
  await assert.rejects(evaluateVoucher(fakeDb(welcome), 1, 'WELCOME50', { subtotalCentavos: 11_900, seasons: new Set(), now }), /at least ₱300/);
  await assert.rejects(evaluateVoucher(fakeDb(spooky), 1, 'SPOOKY15', { subtotalCentavos: 50_000, seasons: new Set(), now }), /Halloween cookie/);
  await assert.rejects(evaluateVoucher(fakeDb(welcome, { earlierOrder: true }), 1, 'WELCOME50', { subtotalCentavos: 40_000, seasons: new Set(), now }), /first order/);
  await assert.rejects(evaluateVoucher(fakeDb({ ...welcome, firstOrderOnly: false }, { used: true }), 1, 'WELCOME50', { subtotalCentavos: 40_000, seasons: new Set(), now }), /already used/);
  await assert.rejects(evaluateVoucher(fakeDb(spooky), 1, 'SPOOKY15', { subtotalCentavos: 50_000, seasons: halloween, now: new Date('2026-12-01T00:00:00Z') }), /expired/);
  await assert.rejects(evaluateVoucher(fakeDb(null), 1, 'NOPE123', { subtotalCentavos: 50_000, seasons: halloween, now }), /could not find/);
  const ok = await evaluateVoucher(fakeDb(spooky), 1, 'spooky15', { subtotalCentavos: 50_000, seasons: halloween, now });
  assert.equal(ok.discountCentavos, 7_500);
});
