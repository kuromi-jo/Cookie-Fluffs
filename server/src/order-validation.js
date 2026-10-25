/**
 * @file order-validation.js
 * @description Strict checkout request validation and canonical idempotency fingerprints.
 */
import crypto from 'node:crypto';
import { validateNcrLocation } from './geography.js';
import { normalizePhone } from './validation.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const POSTAL_CODE_RE = /^\d{4}$/;
const ONLINE_PAYMENT_METHODS = new Set(['gcash', 'maya', 'card']);
const TOP_LEVEL_FIELDS = new Set([
  'idempotencyKey',
  'fulfillmentMethod',
  'paymentMethod',
  'schedulingMode',
  'contactName',
  'contactPhone',
  'deliveryAddress',
  'notes',
  'agreementAccepted',
  'agreementVersion',
]);
const ADDRESS_FIELDS = new Set([
  'addressLine1',
  'addressLine2',
  'regionCode',
  'region',
  'barangayCode',
  'barangay',
  'cityCode',
  'city',
  'province',
  'postalCode',
]);

function cleanText(value) {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
}

function validateBoundedText(value, label, min, max) {
  const text = cleanText(value);
  if (text.length < min || text.length > max || /[\u0000-\u001f\u007f]/.test(text)) {
    return { value: text, error: `${label} must be ${min} to ${max} characters.` };
  }
  return { value: text, error: null };
}

export function validateOrderRequest(body, {
  agreementRequired = process.env.ORDER_AGREEMENT_REQUIRED?.trim().toLowerCase() === 'true',
  agreementVersion: acceptedAgreementVersion = agreementRequired ? process.env.ORDER_AGREEMENT_VERSION?.trim() : null,
} = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { value: null, errors: { request: 'Send checkout details as a JSON object.' } };
  }

  const errors = {};
  const unknown = Object.keys(body).filter((field) => !TOP_LEVEL_FIELDS.has(field));
  if (unknown.length) errors.request = `Unknown checkout field: ${unknown[0]}.`;

  const idempotencyKey = typeof body.idempotencyKey === 'string' ? body.idempotencyKey.toLowerCase() : '';
  if (!UUID_RE.test(idempotencyKey)) errors.idempotencyKey = 'Send a valid UUID idempotency key.';

  const fulfillmentMethod = body.fulfillmentMethod;
  if (fulfillmentMethod !== 'delivery' && fulfillmentMethod !== 'pickup') {
    errors.fulfillmentMethod = 'Choose delivery or pickup.';
  }

  const expectedPayment = fulfillmentMethod === 'pickup' ? 'cash_on_pickup' : 'cash_on_delivery';
  const paymentMethod = body.paymentMethod;
  if (paymentMethod !== expectedPayment && !ONLINE_PAYMENT_METHODS.has(paymentMethod)) {
    errors.paymentMethod = 'Choose an available payment method for this order.';
  }

  const schedulingMode = body.schedulingMode;
  if (schedulingMode !== 'asap') errors.schedulingMode = 'Scheduling mode must be asap.';

  const contact = validateBoundedText(body.contactName, 'Contact name', 2, 80);
  if (contact.error) errors.contactName = contact.error;
  const contactPhone = normalizePhone(body.contactPhone);
  if (!contactPhone) errors.contactPhone = 'Enter a Philippine mobile number, like 0917 123 4567.';

  const notes = typeof body.notes === 'string' ? body.notes.trim() : '';
  if (notes.length > 500) errors.notes = 'Keep order notes to 500 characters or fewer.';

  let agreementAccepted = false;
  let agreementVersion = null;
  if (agreementRequired) {
    if (body.agreementAccepted !== true) errors.agreementAccepted = 'Review and accept the order agreement.';
    if (!acceptedAgreementVersion || body.agreementVersion !== acceptedAgreementVersion) {
      errors.agreementVersion = 'The order agreement changed. Review it again before placing your order.';
    }
    agreementAccepted = body.agreementAccepted === true;
    agreementVersion = body.agreementVersion === acceptedAgreementVersion ? body.agreementVersion : null;
  } else if ('agreementAccepted' in body || 'agreementVersion' in body) {
    errors.agreementAccepted = 'The draft order agreement is unavailable in production.';
  }

  let deliveryAddress = null;
  if (fulfillmentMethod === 'delivery') {
    const address = body.deliveryAddress;
    if (!address || typeof address !== 'object' || Array.isArray(address)) {
      errors.deliveryAddress = 'Enter a delivery address.';
    } else {
      const unknownAddress = Object.keys(address).filter((field) => !ADDRESS_FIELDS.has(field));
      if (unknownAddress.length) errors.deliveryAddress = `Unknown address field: ${unknownAddress[0]}.`;
      const line1 = validateBoundedText(address.addressLine1, 'Address line', 5, 120);
      const line2 = validateBoundedText(address.addressLine2 ?? '', 'Address line 2', 0, 120);
      const barangay = validateBoundedText(address.barangay, 'Barangay', 2, 80);
      const city = validateBoundedText(address.city, 'City or municipality', 2, 80);
      const province = validateBoundedText(address.province, 'Province or region', 2, 80);
      const postalCode = cleanText(address.postalCode);
      const location = validateNcrLocation(address);
      if (line1.error) errors.addressLine1 = line1.error;
      if (line2.error) errors.addressLine2 = line2.error;
      if (barangay.error) errors.barangay = barangay.error;
      if (city.error) errors.city = city.error;
      if (province.error) errors.province = province.error;
      if (!POSTAL_CODE_RE.test(postalCode)) errors.postalCode = 'Enter a 4-digit Philippine postal code.';
      Object.assign(errors, location.errors);
      deliveryAddress = {
        addressLine1: line1.value,
        addressLine2: line2.value,
        regionCode: location.value?.regionCode ?? '',
        region: location.value?.region ?? '',
        barangayCode: location.value?.barangayCode ?? '',
        barangay: location.value?.barangay ?? barangay.value,
        cityCode: location.value?.cityCode ?? '',
        city: location.value?.city ?? city.value,
        province: location.value?.province ?? province.value,
        postalCode,
      };
    }
  } else if (fulfillmentMethod === 'pickup' && body.deliveryAddress != null) {
    errors.deliveryAddress = 'Pickup orders do not use a delivery address.';
  }

  const value = {
    idempotencyKey,
    fulfillmentMethod,
    paymentMethod,
    schedulingMode,
    contactName: contact.value,
    contactPhone,
    deliveryAddress,
    notes,
    agreementAccepted,
    agreementVersion,
  };
  return { value, errors };
}

/** The key is excluded: one key may only represent one canonical set of checkout details. */
export function orderRequestFingerprint(value) {
  const { idempotencyKey: _key, ...details } = value;
  return crypto.createHash('sha256').update(JSON.stringify(details)).digest('hex');
}
