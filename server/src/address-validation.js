/**
 * @file address-validation.js
 * @description Strict saved-address validation using the canonical NCR PSGC hierarchy.
 */
import { getNcrGeography, validateNcrLocation } from './geography.js';
import { normalizePhone } from './validation.js';

const BASE_FIELDS = new Set([
  'label',
  'recipientName',
  'recipientPhone',
  'addressLine1',
  'addressLine2',
  'cityCode',
  'barangayCode',
  'postalCode',
]);
const POSTAL_CODE_RE = /^\d{4}$/;
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

function cleanText(value) {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
}

function bounded(value, label, min, max) {
  const text = cleanText(value);
  return {
    value: text,
    error: text.length < min || text.length > max || CONTROL_RE.test(text)
      ? `${label} must be ${min} to ${max} characters.`
      : null,
  };
}

/** Validates a customer-owned address and returns canonical NCR labels. */
export function validateAddressRequest(body, { allowDefault = false } = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { value: null, errors: { request: 'Send address details as a JSON object.' } };
  }

  const allowed = allowDefault ? new Set([...BASE_FIELDS, 'makeDefault']) : BASE_FIELDS;
  const errors = {};
  const unknown = Object.keys(body).filter((field) => !allowed.has(field));
  if (unknown.length) errors.request = `Unknown address field: ${unknown[0]}.`;

  const label = bounded(body.label, 'Address label', 1, 30);
  const recipientName = bounded(body.recipientName, 'Recipient name', 2, 80);
  const recipientPhone = normalizePhone(body.recipientPhone);
  const addressLine1 = bounded(body.addressLine1, 'Street address', 5, 120);
  const addressLine2 = bounded(body.addressLine2 ?? '', 'Unit or landmark', 0, 120);
  const postalCode = cleanText(body.postalCode);
  if (label.error) errors.label = label.error;
  if (recipientName.error) errors.recipientName = recipientName.error;
  if (!recipientPhone) errors.recipientPhone = 'Enter a Philippine mobile number, like 0917 123 4567.';
  if (addressLine1.error) errors.addressLine1 = addressLine1.error;
  if (addressLine2.error) errors.addressLine2 = addressLine2.error;
  if (!POSTAL_CODE_RE.test(postalCode)) errors.postalCode = 'Enter a 4-digit Philippine postal code.';
  if (allowDefault && 'makeDefault' in body && typeof body.makeDefault !== 'boolean') {
    errors.makeDefault = 'Choose whether this should be your default address.';
  }

  const geography = getNcrGeography();
  const cityCode = typeof body.cityCode === 'string' ? body.cityCode : '';
  const barangayCode = typeof body.barangayCode === 'string' ? body.barangayCode : '';
  const city = geography.cities.find((entry) => entry.code === cityCode);
  const barangay = city?.barangays.find((entry) => entry.code === barangayCode);
  const location = validateNcrLocation({
    regionCode: geography.region.code,
    province: geography.region.provinceEquivalent,
    cityCode,
    city: city?.name ?? '',
    barangayCode,
    barangay: barangay?.name ?? '',
  });
  if (!city) errors.cityCode = 'Choose a valid NCR city or municipality.';
  if (!barangay) errors.barangayCode = city
    ? 'Choose a barangay that belongs to the selected city or municipality.'
    : 'Choose a valid barangay.';
  if (city && barangay) Object.assign(errors, location.errors);

  return {
    value: {
      label: label.value,
      recipientName: recipientName.value,
      recipientPhone: recipientPhone ?? '',
      addressLine1: addressLine1.value,
      addressLine2: addressLine2.value,
      regionCode: location.value?.regionCode ?? geography.region.code,
      region: location.value?.region ?? geography.region.name,
      province: location.value?.province ?? geography.region.provinceEquivalent,
      cityCode,
      city: location.value?.city ?? city?.name ?? '',
      barangayCode,
      barangay: location.value?.barangay ?? barangay?.name ?? '',
      postalCode,
      makeDefault: allowDefault && body.makeDefault === true,
    },
    errors,
  };
}
