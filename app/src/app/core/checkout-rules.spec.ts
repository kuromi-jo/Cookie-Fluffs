/**
 * @file checkout-rules.spec.ts
 * @description Checkout access, validation, cart review, and payload boundary tests.
 */
import { describe, expect, it } from 'vitest';
import { checkoutConfigFor } from './checkout-config';
import {
  applySavedAddress,
  canAutofillSavedAddress,
  CheckoutFormValue,
  buildOrderDetails,
  canEditCheckoutStep,
  canStartOrderSubmission,
  cashPaymentLabel,
  canonicalOrderDetails,
  cartSelectionSignature,
  checkoutAccess,
  checkoutStepAfter,
  checkoutPreview,
  prefillCheckout,
  selectedCartLines,
  selectCheckoutCity,
  validateCheckout,
} from './checkout-rules';
import { Cart, SavedAddress, User } from './models';

const deliveryForm = (changes: Partial<CheckoutFormValue> = {}): CheckoutFormValue => ({
  fulfillmentMethod: 'delivery',
  paymentMethod: 'cash_on_delivery',
  contactName: 'Maria Santos',
  contactPhone: '0917 123 4567',
  addressLine1: '12 Test Street',
  addressLine2: '',
  regionCode: '1300000000',
  region: 'National Capital Region (NCR)',
  barangayCode: '1381300001',
  barangay: 'Alicia',
  cityCode: '1381300000',
  city: 'Quezon City',
  province: 'Metro Manila',
  postalCode: '1100',
  notes: '',
  ...changes,
});

const cart = (subtotal = 420): Cart => ({
  items: [
    { productId: 1, quantity: 2, name: 'Choco', tagline: '', imageUrl: '', category: 'classic', price: 100, regularPrice: 120, lineTotal: 200, selected: true },
    { productId: 2, quantity: 1, name: 'Mango', tagline: '', imageUrl: '', category: 'fruity', price: 90, regularPrice: 90, lineTotal: 90, selected: false },
  ],
  boxes: [{ id: 5, size: 4, quantity: 1, selected: true, cookies: [1, 2, 3, 4].map((id) => ({ productId: id, name: `Cookie ${id}`, imageUrl: '', price: 55 })), regularPrice: 220, discountPercent: 5, price: 209, lineTotal: 209 }],
  itemCount: 4,
  selectedCount: 3,
  subtotal,
  deliveryFee: subtotal >= 500 ? 0 : 49,
  freeDeliveryMin: 500,
  total: subtotal + (subtotal >= 500 ? 0 : 49),
});

describe('checkout entry and review', () => {
  it('requires authentication', () => expect(checkoutAccess(false, 2)).toBe('login'));
  it('prevents checkout with an empty selection', () => expect(checkoutAccess(true, 0)).toBe('cart'));
  it('allows authenticated selected carts', () => expect(checkoutAccess(true, 1)).toBe('checkout'));

  it('shows only selected singles and boxes without mutating the cart', () => {
    const source = cart();
    const selected = selectedCartLines(source);
    expect(selected.items.map((item) => item.productId)).toEqual([1]);
    expect(selected.boxes.map((box) => box.id)).toEqual([5]);
    expect(source.items).toHaveLength(2);
  });

  it('retains product and box review information', () => {
    const selected = selectedCartLines(cart());
    expect(selected.items[0]).toMatchObject({ name: 'Choco', quantity: 2, lineTotal: 200 });
    expect(selected.boxes[0]).toMatchObject({ size: 4, discountPercent: 5, lineTotal: 209 });
    expect(selected.boxes[0].cookies).toHaveLength(4);
  });

  it('detects quantity, price, selection, and box-content changes', () => {
    const first = cart();
    const changed = cart();
    changed.boxes[0].cookies[0].productId = 99;
    expect(cartSelectionSignature(changed)).not.toBe(cartSelectionSignature(first));
  });
});

describe('guided checkout steps', () => {
  it('progresses from Information to Fulfillment to Payment to Review', () => {
    expect(checkoutStepAfter(0, 'next')).toBe(1);
    expect(checkoutStepAfter(1, 'next')).toBe(2);
    expect(checkoutStepAfter(2, 'next')).toBe(3);
    expect(checkoutStepAfter(3, 'next')).toBe(3);
  });

  it('moves back one step without losing form state', () => {
    const form = deliveryForm({ addressLine1: '88 Preserved Street' });
    expect(checkoutStepAfter(3, 'back')).toBe(2);
    expect(form.addressLine1).toBe('88 Preserved Street');
  });

  it('allows Review to edit only an earlier step', () => {
    expect(canEditCheckoutStep(3, 0)).toBe(true);
    expect(canEditCheckoutStep(3, 2)).toBe(true);
    expect(canEditCheckoutStep(1, 2)).toBe(false);
  });

  it('blocks final submission outside Review and during duplicate clicks', () => {
    expect(canStartOrderSubmission(2, false, false)).toBe(false);
    expect(canStartOrderSubmission(3, true, false)).toBe(false);
    expect(canStartOrderSubmission(3, false, true)).toBe(false);
    expect(canStartOrderSubmission(3, false, false)).toBe(true);
  });

  it('shows only the approved cash method for each fulfillment path', () => {
    expect(cashPaymentLabel('delivery')).toBe('Cash on Delivery');
    expect(cashPaymentLabel('pickup')).toBe('Cash on Pickup');
  });

  it('preserves delivery fields while the pickup payload hides them', () => {
    const form = deliveryForm({ addressLine1: '12 Preserved Street' });
    const pickup = buildOrderDetails({ ...form, fulfillmentMethod: 'pickup', paymentMethod: 'cash_on_pickup' });
    expect(pickup.deliveryAddress).toBeNull();
    expect(form.addressLine1).toBe('12 Preserved Street');
  });
});

describe('checkout pricing preview', () => {
  it('shows a ₱49 delivery fee below ₱500', () => expect(checkoutPreview(cart(420), 'delivery')).toEqual({ subtotal: 420, deliveryFee: 49, total: 469 }));
  it('shows free delivery at ₱500', () => expect(checkoutPreview(cart(500), 'delivery')).toEqual({ subtotal: 500, deliveryFee: 0, total: 500 }));
  it('shows no delivery charge for pickup', () => expect(checkoutPreview(cart(420), 'pickup')).toEqual({ subtotal: 420, deliveryFee: 0, total: 420 }));
});

describe('checkout form and API boundary', () => {
  it('accepts complete delivery details', () => expect(validateCheckout(deliveryForm())).toEqual({}));

  it('clears a stale barangay when the city changes', () => {
    const changed = selectCheckoutCity(deliveryForm(), { code: '1381500000', name: 'Taguig' });
    expect(changed).toMatchObject({ city: 'Taguig', barangay: '', barangayCode: '' });
    expect(selectCheckoutCity(deliveryForm(), { code: '1381300000', name: 'Quezon City' }).barangay).toBe('Alicia');
  });

  it('does not require an address for pickup', () => {
    expect(validateCheckout(deliveryForm({ fulfillmentMethod: 'pickup', paymentMethod: 'cash_on_pickup', addressLine1: '', barangay: '', city: '', province: '', postalCode: '' }))).toEqual({});
  });

  it('validates contact details and every required delivery field', () => {
    const errors = validateCheckout(deliveryForm({ contactName: 'A', contactPhone: '123', addressLine1: '', barangayCode: '', barangay: '', cityCode: '', city: '', province: '', postalCode: 'ABC' }));
    expect(Object.keys(errors)).toEqual(expect.arrayContaining(['contactName', 'contactPhone', 'addressLine1', 'barangayCode', 'barangay', 'cityCode', 'city', 'province', 'postalCode']));
  });

  it('enforces optional address and notes limits', () => {
    expect(validateCheckout(deliveryForm({ addressLine2: 'x'.repeat(121), notes: 'x'.repeat(501) }))).toMatchObject({ addressLine2: expect.any(String), notes: expect.any(String) });
  });

  it('normalizes contact data and excludes prices, totals, and user IDs', () => {
    const payload = buildOrderDetails(deliveryForm({ contactName: '  Maria   Santos ', contactPhone: '0917 123 4567' }));
    expect(payload).toMatchObject({ contactName: 'Maria Santos', contactPhone: '+639171234567', paymentMethod: 'cash_on_delivery', schedulingMode: 'asap' });
    expect(payload).not.toHaveProperty('total');
    expect(payload).not.toHaveProperty('price');
    expect(payload).not.toHaveProperty('userId');
  });

  it('adds only the approved agreement version when checkout supplies acceptance', () => {
    const payload = buildOrderDetails(deliveryForm(), { accepted: true, version: 'draft-2026-10-24-v1' });
    expect(payload).toMatchObject({ agreementAccepted: true, agreementVersion: 'draft-2026-10-24-v1' });
    expect(buildOrderDetails(deliveryForm())).not.toHaveProperty('agreementAccepted');
  });

  it('omits preserved address values from pickup payloads', () => {
    const payload = buildOrderDetails(deliveryForm({ fulfillmentMethod: 'pickup', paymentMethod: 'cash_on_pickup' }));
    expect(payload.deliveryAddress).toBeNull();
    expect(payload.paymentMethod).toBe('cash_on_pickup');
  });

  it('prefills an untouched form from the profile', () => {
    const user = { fullName: 'Maria Santos', phone: '+639171234567' } as User;
    expect(prefillCheckout(deliveryForm({ contactName: '', contactPhone: '' }), user)).toMatchObject({ contactName: 'Maria Santos', contactPhone: '+639171234567' });
  });

  it('preserves customer edits when profile data is applied again', () => {
    const user = { fullName: 'Profile Name', phone: '+639000000000' } as User;
    expect(prefillCheckout(deliveryForm({ contactName: 'Delivery Contact', contactPhone: '09181234567' }), user)).toMatchObject({ contactName: 'Delivery Contact', contactPhone: '09181234567' });
  });

  it('creates the same canonical payload regardless of object insertion order', () => {
    const details = buildOrderDetails(deliveryForm());
    expect(canonicalOrderDetails(details)).toBe(canonicalOrderDetails({ ...details, deliveryAddress: details.deliveryAddress && { ...details.deliveryAddress } }));
  });
});

describe('saved-address checkout reuse', () => {
  const address = {
    id: 'address-1', label: 'Home', recipientName: 'Ana Reyes', recipientPhone: '+639181234567',
    addressLine1: '88 Bakery Lane', addressLine2: 'Unit 4', regionCode: '1300000000',
    region: 'National Capital Region (NCR)', province: 'Metro Manila', cityCode: '1381300000',
    city: 'Quezon City', barangayCode: '1381300001', barangay: 'Alicia', postalCode: '1100',
    isDefault: true, createdAt: '', updatedAt: '',
  } as SavedAddress;

  it('copies saved recipient and canonical location values without an address ID', () => {
    const form = applySavedAddress(deliveryForm({ contactName: '', addressLine1: '' }), address);
    expect(form).toMatchObject({ contactName: 'Ana Reyes', addressLine1: '88 Bakery Lane', city: 'Quezon City' });
    expect(buildOrderDetails(form)).not.toHaveProperty('addressId');
  });

  it('allows delayed default prefill only while relevant fields are untouched and empty', () => {
    const empty = deliveryForm({ addressLine1: '', cityCode: '', barangayCode: '', postalCode: '' });
    expect(canAutofillSavedAddress(empty, new Set())).toBe(true);
    expect(canAutofillSavedAddress(empty, new Set(['addressLine1']))).toBe(false);
    expect(canAutofillSavedAddress({ ...empty, addressLine1: 'Customer typing' }, new Set())).toBe(false);
  });
});

describe('fulfillment release safeguards', () => {
  it('disables delivery and pickup in production until business configuration is approved', () => {
    const production = checkoutConfigFor(true);
    expect(production.delivery.enabled).toBe(false);
    expect(production.pickup.enabled).toBe(false);
    expect(production.pickup.unavailableMessage).toMatch(/address and hours/i);
  });

  it('enables both paths only in explicit nonproduction configuration', () => {
    const development = checkoutConfigFor(false);
    expect(development).toMatchObject({ nonProductionDemo: true, delivery: { enabled: true }, pickup: { enabled: true } });
  });

  it('keeps vouchers visibly unavailable without backend support', () => {
    const development = checkoutConfigFor(false);
    expect(development.voucher.enabled).toBe(false);
    expect(development.voucher.unavailableMessage).toMatch(/future update/i);
  });
});
