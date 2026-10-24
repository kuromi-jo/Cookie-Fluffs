/**
 * @file checkout-rules.ts
 * @description Pure checkout validation, cart reconciliation, and preview helpers.
 */
import {
  Cart,
  CartBox,
  CartItem,
  DeliveryAddress,
  FulfillmentMethod,
  OrderDetails,
  PaymentMethod,
  SavedAddress,
  User,
} from './models';
import { normalizePhone } from './signup-rules';

export interface CheckoutFormValue {
  fulfillmentMethod: FulfillmentMethod;
  paymentMethod: PaymentMethod;
  contactName: string;
  contactPhone: string;
  addressLine1: string;
  addressLine2: string;
  regionCode: string;
  region: string;
  barangayCode: string;
  barangay: string;
  cityCode: string;
  city: string;
  province: string;
  postalCode: string;
  notes: string;
}

export type CheckoutField = keyof CheckoutFormValue;
export type CheckoutErrors = Partial<Record<CheckoutField | 'fulfillment', string>>;
export type CheckoutStep = 'information' | 'fulfillment' | 'payment' | 'review';

export const CHECKOUT_STEPS: { id: CheckoutStep; label: string }[] = [
  { id: 'information', label: 'Information' },
  { id: 'fulfillment', label: 'Fulfillment' },
  { id: 'payment', label: 'Payment' },
  { id: 'review', label: 'Review' },
];

export function checkoutStepAfter(index: number, direction: 'next' | 'back'): number {
  return Math.max(0, Math.min(CHECKOUT_STEPS.length - 1, index + (direction === 'next' ? 1 : -1)));
}

export function canEditCheckoutStep(currentIndex: number, targetIndex: number): boolean {
  return targetIndex >= 0 && targetIndex < currentIndex;
}

export function canStartOrderSubmission(currentStep: number, submitting: boolean, completed: boolean): boolean {
  return currentStep === CHECKOUT_STEPS.length - 1 && !submitting && !completed;
}

export function cashPaymentLabel(fulfillment: FulfillmentMethod): 'Cash on Delivery' | 'Cash on Pickup' {
  return fulfillment === 'pickup' ? 'Cash on Pickup' : 'Cash on Delivery';
}

export function paymentLabel(method: PaymentMethod): string {
  return {
    cash_on_delivery: 'Cash on Delivery',
    cash_on_pickup: 'Cash on Pickup',
    gcash: 'GCash',
    maya: 'Maya',
    card: 'Credit / Debit Card',
  }[method];
}

export function isOnlinePayment(method: PaymentMethod): boolean {
  return method === 'gcash' || method === 'maya' || method === 'card';
}

export function checkoutAccess(isLoggedIn: boolean, selectedCount: number): 'login' | 'cart' | 'checkout' {
  if (!isLoggedIn) return 'login';
  return selectedCount > 0 ? 'checkout' : 'cart';
}

export function prefillCheckout(form: CheckoutFormValue, user: User | null): CheckoutFormValue {
  if (!user) return form;
  return { ...form, contactName: form.contactName || user.fullName, contactPhone: form.contactPhone || user.phone };
}

export const SAVED_ADDRESS_FIELDS: CheckoutField[] = [
  'contactName', 'contactPhone', 'addressLine1', 'addressLine2', 'cityCode', 'city',
  'barangayCode', 'barangay', 'postalCode',
];

/** Copies an immutable saved-address value into the current checkout draft. */
export function applySavedAddress(form: CheckoutFormValue, address: SavedAddress): CheckoutFormValue {
  return {
    ...form,
    contactName: address.recipientName,
    contactPhone: address.recipientPhone,
    addressLine1: address.addressLine1,
    addressLine2: address.addressLine2,
    regionCode: address.regionCode,
    region: address.region,
    province: address.province,
    cityCode: address.cityCode,
    city: address.city,
    barangayCode: address.barangayCode,
    barangay: address.barangay,
    postalCode: address.postalCode,
  };
}

/** Delayed address loading may only prefill a delivery form the customer has not touched. */
export function canAutofillSavedAddress(form: CheckoutFormValue, touched: ReadonlySet<CheckoutField>): boolean {
  return !SAVED_ADDRESS_FIELDS.some((field) => touched.has(field))
    && !form.addressLine1 && !form.addressLine2 && !form.cityCode && !form.barangayCode && !form.postalCode;
}

export function selectCheckoutCity(
  form: CheckoutFormValue,
  city: { code: string; name: string },
): CheckoutFormValue {
  const changed = form.cityCode !== city.code;
  return {
    ...form,
    cityCode: city.code,
    city: city.name,
    barangayCode: changed ? '' : form.barangayCode,
    barangay: changed ? '' : form.barangay,
  };
}

const CONTROL_RE = /[\u0000-\u001f\u007f]/;
const POSTAL_CODE_RE = /^\d{4}$/;

function cleanText(value: unknown): string {
  return String(value ?? '').trim().replace(/\s+/g, ' ');
}

function bounded(value: unknown, label: string, min: number, max: number): string | null {
  const text = cleanText(value);
  return text.length < min || text.length > max || CONTROL_RE.test(text)
    ? `${label} must be ${min} to ${max} characters.`
    : null;
}

export function validateCheckoutField(field: CheckoutField, form: CheckoutFormValue): string | null {
  switch (field) {
    case 'fulfillmentMethod':
      return form.fulfillmentMethod === 'delivery' || form.fulfillmentMethod === 'pickup'
        ? null
        : 'Choose delivery or pickup.';
    case 'paymentMethod': {
      const cash = form.fulfillmentMethod === 'pickup' ? 'cash_on_pickup' : 'cash_on_delivery';
      return form.paymentMethod === cash || isOnlinePayment(form.paymentMethod)
        ? null
        : 'Choose an available payment method.';
    }
    case 'contactName':
      return bounded(form.contactName, 'Contact name', 2, 80);
    case 'contactPhone':
      return normalizePhone(form.contactPhone) ? null : 'Enter a Philippine mobile number, like 0917 123 4567.';
    case 'addressLine1':
      return form.fulfillmentMethod === 'delivery' ? bounded(form.addressLine1, 'Address line', 5, 120) : null;
    case 'addressLine2':
      return form.fulfillmentMethod === 'delivery' ? bounded(form.addressLine2, 'Address line 2', 0, 120) : null;
    case 'regionCode':
      return form.fulfillmentMethod === 'delivery' && form.regionCode !== '1300000000'
        ? 'Delivery is limited to the National Capital Region.'
        : null;
    case 'region':
      return form.fulfillmentMethod === 'delivery' && form.region !== 'National Capital Region (NCR)'
        ? 'Region must be National Capital Region (NCR).'
        : null;
    case 'barangayCode':
      return form.fulfillmentMethod === 'delivery' && !/^\d{10}$/.test(form.barangayCode)
        ? 'Choose a barangay.'
        : null;
    case 'barangay':
      return form.fulfillmentMethod === 'delivery' ? bounded(form.barangay, 'Barangay', 2, 80) : null;
    case 'city':
      return form.fulfillmentMethod === 'delivery' ? bounded(form.city, 'City or municipality', 2, 80) : null;
    case 'cityCode':
      return form.fulfillmentMethod === 'delivery' && !/^\d{10}$/.test(form.cityCode)
        ? 'Choose an NCR city or municipality.'
        : null;
    case 'province':
      return form.fulfillmentMethod === 'delivery' ? bounded(form.province, 'Province or region', 2, 80) : null;
    case 'postalCode':
      return form.fulfillmentMethod === 'delivery' && !POSTAL_CODE_RE.test(cleanText(form.postalCode))
        ? 'Enter a 4-digit Philippine postal code.'
        : null;
    case 'notes':
      return String(form.notes ?? '').trim().length > 500 ? 'Keep order notes to 500 characters or fewer.' : null;
  }
}

export function validateCheckout(form: CheckoutFormValue): CheckoutErrors {
  const fields = Object.keys(form) as CheckoutField[];
  return Object.fromEntries(
    fields.map((field) => [field, validateCheckoutField(field, form)]).filter((entry) => entry[1]),
  ) as CheckoutErrors;
}

export function buildOrderDetails(
  form: CheckoutFormValue,
  agreement?: { accepted: true; version: string },
): OrderDetails {
  const deliveryAddress: DeliveryAddress | null = form.fulfillmentMethod === 'delivery'
    ? {
      addressLine1: cleanText(form.addressLine1),
      addressLine2: cleanText(form.addressLine2),
      regionCode: form.regionCode,
      region: form.region,
      barangayCode: form.barangayCode,
      barangay: cleanText(form.barangay),
      cityCode: form.cityCode,
      city: cleanText(form.city),
      province: cleanText(form.province),
      postalCode: cleanText(form.postalCode),
    }
    : null;
  return {
    fulfillmentMethod: form.fulfillmentMethod,
    paymentMethod: form.paymentMethod,
    schedulingMode: 'asap',
    contactName: cleanText(form.contactName),
    contactPhone: normalizePhone(form.contactPhone) ?? cleanText(form.contactPhone),
    deliveryAddress,
    notes: String(form.notes ?? '').trim(),
    ...(agreement ? { agreementAccepted: agreement.accepted, agreementVersion: agreement.version } : {}),
  };
}

export function selectedCartLines(cart: Cart): { items: CartItem[]; boxes: CartBox[] } {
  return {
    items: cart.items.filter((item) => item.selected),
    boxes: cart.boxes.filter((box) => box.selected),
  };
}

/** Captures only order-affecting cart state so a fresh server cart can be reconciled before POST. */
export function cartSelectionSignature(cart: Cart): string {
  const selected = selectedCartLines(cart);
  return JSON.stringify({
    items: selected.items.map((item) => [item.productId, item.quantity, item.price, item.lineTotal]),
    boxes: selected.boxes.map((box) => [
      box.id,
      box.size,
      box.quantity,
      box.price,
      box.lineTotal,
      box.cookies.map((cookie) => [cookie.productId, cookie.price]),
    ]),
  });
}

export function checkoutPreview(cart: Cart, fulfillment: FulfillmentMethod): {
  subtotal: number;
  deliveryFee: number;
  total: number;
} {
  const deliveryFee = fulfillment === 'delivery' ? cart.deliveryFee : 0;
  return { subtotal: cart.subtotal, deliveryFee, total: cart.subtotal + deliveryFee };
}

/** Stable property order for a persisted checkout-attempt fingerprint. */
export function canonicalOrderDetails(details: OrderDetails): string {
  return stableStringify(details);
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}
