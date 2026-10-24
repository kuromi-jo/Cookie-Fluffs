/**
 * @file geography.js
 * @description Canonical NCR geography lookup and delivery-address validation.
 */
import { NCR_PSGC } from './data/ncr-psgc-2026-09.js';

export const NCR_REGION_CODE = NCR_PSGC.region.code;
export const NCR_REGION_NAME = NCR_PSGC.region.name;
export const NCR_PROVINCE_EQUIVALENT = NCR_PSGC.region.provinceEquivalent;

const cityByCode = new Map(NCR_PSGC.cities.map((city) => [city.code, city]));
const barangayByCode = new Map(
  NCR_PSGC.cities.flatMap((city) => city.barangays.map((barangay) => [barangay.code, { ...barangay, city }])),
);

function sameName(left, right) {
  return String(left ?? '').trim().replace(/\s+/g, ' ').localeCompare(right, undefined, { sensitivity: 'base' }) === 0;
}
/** Returns the immutable public NCR selector payload. */
export function getNcrGeography() {
  return NCR_PSGC;
}

/** Validates PSGC parentage and replaces submitted labels with canonical snapshot names. */
export function validateNcrLocation(address) {
  const errors = {};
  const regionCode = typeof address?.regionCode === 'string' ? address.regionCode : '';
  const cityCode = typeof address?.cityCode === 'string' ? address.cityCode : '';
  const barangayCode = typeof address?.barangayCode === 'string' ? address.barangayCode : '';
  const city = cityByCode.get(cityCode);
  const barangay = barangayByCode.get(barangayCode);

  if (regionCode !== NCR_REGION_CODE) errors.regionCode = 'Delivery is limited to the National Capital Region.';
  if (!sameName(address?.province, NCR_PROVINCE_EQUIVALENT)) {
    errors.province = 'Province-equivalent must be Metro Manila.';
  }
  if (!city) errors.cityCode = 'Choose a valid NCR city or municipality.';
  if (city && !sameName(address?.city, city.name)) errors.city = 'City name does not match the selected PSGC code.';
  if (!barangay) errors.barangayCode = 'Choose a valid barangay.';
  if (barangay && city && barangay.city.code !== city.code) {
    errors.barangayCode = 'Choose a barangay that belongs to the selected city or municipality.';
  }
  if (barangay && !sameName(address?.barangay, barangay.name)) {
    errors.barangay = 'Barangay name does not match the selected PSGC code.';
  }

  return {
    errors,
    value: city && barangay && !Object.keys(errors).length
      ? {
        regionCode: NCR_REGION_CODE,
        region: NCR_REGION_NAME,
        cityCode: city.code,
        city: city.name,
        barangayCode: barangay.code,
        barangay: barangay.name,
        province: NCR_PROVINCE_EQUIVALENT,
      }
      : null,
  };
}
