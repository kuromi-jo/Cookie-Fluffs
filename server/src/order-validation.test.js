/**
 * @file order-validation.test.js
 * @description Unit tests for checkout request validation and fingerprints.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { orderRequestFingerprint, validateOrderRequest } from './order-validation.js';

const ORDER_AGREEMENT_VERSION = 'draft-2026-10-24-v1';
process.env.ORDER_AGREEMENT_REQUIRED = 'true';
process.env.ORDER_AGREEMENT_VERSION = ORDER_AGREEMENT_VERSION;

const key = '123e4567-e89b-42d3-a456-426614174000';
const delivery = {
  idempotencyKey: key,
  fulfillmentMethod: 'delivery',
  paymentMethod: 'cash_on_delivery',
  schedulingMode: 'asap',
  contactName: 'Sample Customer',
  contactPhone: '0917 123 4567',
  deliveryAddress: {
    addressLine1: 'House 12, Example Street',
    addressLine2: '',
    regionCode: '1300000000',
    region: 'National Capital Region (NCR)',
    barangayCode: '1381300001',
    barangay: 'Alicia',
    cityCode: '1381300000',
    city: 'Quezon City',
    province: 'Metro Manila',
    postalCode: '1100',
  },
  notes: '',
  agreementAccepted: true,
  agreementVersion: ORDER_AGREEMENT_VERSION,
};

test('accepts and normalizes delivery checkout details', () => {
  const result = validateOrderRequest(delivery);
  assert.deepEqual(result.errors, {});
  assert.equal(result.value.contactPhone, '+639171234567');
});

test('accepts pickup without an address', () => {
  const result = validateOrderRequest({
    ...delivery,
    fulfillmentMethod: 'pickup',
    paymentMethod: 'cash_on_pickup',
    deliveryAddress: undefined,
  });
  assert.deepEqual(result.errors, {});
  assert.equal(result.value.deliveryAddress, null);
});

test('accepts configured online methods for either fulfillment method', () => {
  for (const paymentMethod of ['gcash', 'maya', 'card']) {
    assert.deepEqual(validateOrderRequest({ ...delivery, paymentMethod }).errors, {});
    assert.deepEqual(validateOrderRequest({
      ...delivery,
      fulfillmentMethod: 'pickup',
      paymentMethod,
      deliveryAddress: undefined,
    }).errors, {});
  }
});

test('rejects invalid fulfillment, payment, scheduling, phone, address, key, and notes', () => {
  const result = validateOrderRequest({
    ...delivery,
    idempotencyKey: 'bad-key',
    fulfillmentMethod: 'courier',
    paymentMethod: 'bitcoin',
    schedulingMode: 'tomorrow',
    contactPhone: '123',
    deliveryAddress: null,
    notes: 'x'.repeat(501),
  });
  for (const field of ['idempotencyKey', 'fulfillmentMethod', 'paymentMethod', 'schedulingMode', 'contactPhone', 'notes']) {
    assert.ok(result.errors[field]);
  }
});

test('rejects missing delivery fields and pickup addresses', () => {
  const missing = validateOrderRequest({ ...delivery, deliveryAddress: { ...delivery.deliveryAddress, barangay: '' } });
  assert.ok(missing.errors.barangay);
  const pickup = validateOrderRequest({
    ...delivery,
    fulfillmentMethod: 'pickup',
    paymentMethod: 'cash_on_pickup',
  });
  assert.ok(pickup.errors.deliveryAddress);
});

test('rejects unknown top-level, nested, and security-sensitive fields', () => {
  assert.ok(validateOrderRequest({ ...delivery, userId: 99 }).errors.request);
  assert.ok(validateOrderRequest({
    ...delivery,
    deliveryAddress: { ...delivery.deliveryAddress, deliveryFee: 0 },
  }).errors.deliveryAddress);
});

test('requires the current draft agreement in development and rejects stale versions', () => {
  assert.ok(validateOrderRequest({ ...delivery, agreementAccepted: false }).errors.agreementAccepted);
  assert.ok(validateOrderRequest({ ...delivery, agreementVersion: 'draft-old' }).errors.agreementVersion);
});

test('validates the agreement version negotiated from server capabilities', () => {
  const negotiated = 'configured-test-agreement';
  const accepted = validateOrderRequest(
    { ...delivery, agreementVersion: negotiated },
    { agreementRequired: true, agreementVersion: negotiated },
  );
  assert.deepEqual(accepted.errors, {});
  assert.equal(accepted.value.agreementVersion, negotiated);
  assert.ok(validateOrderRequest(delivery, {
    agreementRequired: true,
    agreementVersion: negotiated,
  }).errors.agreementVersion);
});

test('disables draft agreement fields in production', () => {
  const result = validateOrderRequest(delivery, { agreementRequired: false });
  assert.ok(result.errors.agreementAccepted);
  const { agreementAccepted: _accepted, agreementVersion: _version, ...withoutAgreement } = delivery;
  assert.deepEqual(validateOrderRequest(withoutAgreement, { agreementRequired: false }).errors, {});
});

test('fingerprints normalized checkout details but not the idempotency key', () => {
  const first = validateOrderRequest(delivery).value;
  const second = { ...first, idempotencyKey: '223e4567-e89b-42d3-a456-426614174000' };
  assert.equal(orderRequestFingerprint(first), orderRequestFingerprint(second));
  assert.notEqual(orderRequestFingerprint(first), orderRequestFingerprint({ ...first, notes: 'Leave at the door' }));
});
