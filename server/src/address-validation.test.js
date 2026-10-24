/**
 * @file address-validation.test.js
 * @description Saved-address field and canonical NCR validation tests.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { getNcrGeography } from './geography.js';
import { validateAddressRequest } from './address-validation.js';

const city = getNcrGeography().cities.find((entry) => entry.name === 'Quezon City');
const valid = (overrides = {}) => ({
  label: 'Home', recipientName: 'Maria Santos', recipientPhone: '0917 123 4567',
  addressLine1: '12 Cookie Street', addressLine2: '', cityCode: city.code,
  barangayCode: city.barangays[0].code, postalCode: '1100', ...overrides,
});

test('canonicalizes a valid saved NCR address and Philippine phone', () => {
  const result = validateAddressRequest(valid(), { allowDefault: true });
  assert.deepEqual(result.errors, {});
  assert.equal(result.value.city, 'Quezon City');
  assert.equal(result.value.barangay, city.barangays[0].name);
  assert.equal(result.value.recipientPhone, '+639171234567');
});

test('rejects unknown fields and invalid address values', () => {
  const result = validateAddressRequest(valid({ userId: 99, recipientPhone: '123', postalCode: '11' }));
  assert.ok(result.errors.request);
  assert.ok(result.errors.recipientPhone);
  assert.ok(result.errors.postalCode);
});

test('rejects a barangay from another NCR city', () => {
  const other = getNcrGeography().cities.find((entry) => entry.code !== city.code);
  const result = validateAddressRequest(valid({ barangayCode: other.barangays[0].code }));
  assert.match(result.errors.barangayCode, /belongs|valid barangay/);
});

test('only accepts makeDefault on create and requires a boolean', () => {
  assert.ok(validateAddressRequest(valid({ makeDefault: true })).errors.request);
  assert.ok(validateAddressRequest(valid({ makeDefault: 'yes' }), { allowDefault: true }).errors.makeDefault);
});
