/**
 * @file geography.test.js
 * @description Coverage for the versioned NCR hierarchy and parent validation.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { getNcrGeography, validateNcrLocation } from './geography.js';

const geography = getNcrGeography();

test('contains every NCR LGU and all 1,715 barangays', () => {
  assert.equal(geography.version, '2026-09-30');
  assert.equal(geography.cities.length, 17);
  assert.equal(geography.cities.reduce((count, city) => count + city.barangays.length, 0), 1715);
  assert.deepEqual(
    geography.cities.map((city) => city.name).sort(),
    ['Caloocan', 'Las Piñas', 'Makati', 'Malabon', 'Mandaluyong', 'Manila', 'Marikina', 'Muntinlupa',
      'Navotas', 'Parañaque', 'Pasay', 'Pasig', 'Pateros', 'Quezon City', 'San Juan', 'Taguig', 'Valenzuela'].sort(),
  );
});
test('accepts canonical NCR parent relationships', () => {
  const city = geography.cities.find((entry) => entry.name === 'Quezon City');
  const barangay = city.barangays[0];
  const result = validateNcrLocation({
    regionCode: geography.region.code,
    province: 'Metro Manila',
    cityCode: city.code,
    city: city.name,
    barangayCode: barangay.code,
    barangay: barangay.name,
  });
  assert.deepEqual(result.errors, {});
  assert.equal(result.value.city, 'Quezon City');
});

test('rejects non-NCR, mismatched names, and cross-city barangays', () => {
  const [first, second] = geography.cities;
  const result = validateNcrLocation({
    regionCode: '0100000000',
    province: 'Rizal',
    cityCode: first.code,
    city: second.name,
    barangayCode: second.barangays[0].code,
    barangay: 'Wrong name',
  });
  assert.ok(result.errors.regionCode);
  assert.ok(result.errors.province);
  assert.ok(result.errors.city);
  assert.ok(result.errors.barangayCode);
  assert.ok(result.errors.barangay);
});

test('keeps duplicate barangay names distinct by code and parent', () => {
  const matches = geography.cities.flatMap((city) => city.barangays
    .filter((barangay) => barangay.name.toLocaleLowerCase() === 'san isidro')
    .map((barangay) => ({ city: city.code, code: barangay.code })));
  assert.ok(matches.length > 1);
  assert.equal(new Set(matches.map((match) => match.code)).size, matches.length);
  assert.ok(new Set(matches.map((match) => match.city)).size > 1);
});
