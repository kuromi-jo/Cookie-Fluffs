/**
 * @file order-validation.test.js
 * @description Unit tests for checkout request validation and fingerprints.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { orderRequestFingerprint, validateOrderRequest } from './order-validation.js';

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
    barangay: 'Sample Barangay',
    city: 'Quezon City',
    province: 'Metro Manila',
    postalCode: '1100',
  },
  notes: '',
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

test('rejects invalid fulfillment, payment, scheduling, phone, address, key, and notes', () => {
  const result = validateOrderRequest({
    ...delivery,
    idempotencyKey: 'bad-key',
    fulfillmentMethod: 'courier',
    paymentMethod: 'card',
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

test('fingerprints normalized checkout details but not the idempotency key', () => {
  const first = validateOrderRequest(delivery).value;
  const second = { ...first, idempotencyKey: '223e4567-e89b-42d3-a456-426614174000' };
  assert.equal(orderRequestFingerprint(first), orderRequestFingerprint(second));
  assert.notEqual(orderRequestFingerprint(first), orderRequestFingerprint({ ...first, notes: 'Leave at the door' }));
});
