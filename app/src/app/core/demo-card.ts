/**
 * @file demo-card.ts
 * @description Pure formatting and validation rules for the allowlisted card demonstration.
 */
export type DemoCardScenario = 'visa_approved' | 'mastercard_declined';
export type DemoCardBrand = 'Visa' | 'Mastercard' | '';
export type DemoCardFlow = 'approved' | 'declined' | 'three_ds';

export interface DemoCardFields {
  name: string;
  number: string;
  expiry: string;
  cvc: string;
}

export type DemoCardErrors = Partial<Record<keyof DemoCardFields, string>>;

export const DEMO_CARD_VALUES = Object.freeze({
  visa_approved: '4343434343434345',
  mastercard_approved: '5123000000000001',
  visa_three_ds: '4120000000000007',
  visa_declined: '4111111111111111',
});

const APPROVED_CARD_NUMBERS = new Set<string>([
  DEMO_CARD_VALUES.visa_approved,
  DEMO_CARD_VALUES.mastercard_approved,
]);
const SUPPORTED_CARD_NUMBERS = new Set<string>(Object.values(DEMO_CARD_VALUES));

export function cardDigits(value: string): string {
  return value.replace(/\D/g, '').slice(0, 16);
}

export function formatCardNumber(value: string): string {
  return cardDigits(value).replace(/(.{4})/g, '$1 ').trim();
}

export function formatExpiry(value: string): string {
  const digits = value.replace(/\D/g, '').slice(0, 4);
  return digits.length > 2 ? `${digits.slice(0, 2)}/${digits.slice(2)}` : digits;
}

export function detectCardBrand(value: string): DemoCardBrand {
  const digits = cardDigits(value);
  if (digits.startsWith('4')) return 'Visa';
  if (/^5[1-5]/.test(digits)) return 'Mastercard';
  return '';
}

export function passesLuhn(value: string): boolean {
  const digits = cardDigits(value);
  if (digits.length !== 16) return false;
  let sum = 0;
  const parity = digits.length % 2;
  for (let index = 0; index < digits.length; index += 1) {
    let digit = Number(digits[index]);
    if (index % 2 === parity) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }
  return sum % 10 === 0;
}

export function validFutureExpiry(value: string, now = new Date()): boolean {
  const match = /^(0[1-9]|1[0-2])\/(\d{2})$/.exec(value);
  if (!match) return false;
  const month = Number(match[1]);
  const year = 2000 + Number(match[2]);
  return year > now.getFullYear() || (year === now.getFullYear() && month >= now.getMonth() + 1);
}

export function demoCardFlow(fields: DemoCardFields): DemoCardFlow | null {
  const digits = cardDigits(fields.number);
  if (Object.keys(validateDemoCard(fields)).length) return null;
  if (APPROVED_CARD_NUMBERS.has(digits)) return 'approved';
  if (digits === DEMO_CARD_VALUES.visa_three_ds) return 'three_ds';
  if (digits === DEMO_CARD_VALUES.visa_declined) return 'declined';
  return null;
}

export function demoScenarioForFlow(
  flow: DemoCardFlow,
  authenticationApproved?: boolean,
): DemoCardScenario | null {
  if (flow === 'approved') return 'visa_approved';
  if (flow === 'declined') return 'mastercard_declined';
  if (authenticationApproved === true) return 'visa_approved';
  if (authenticationApproved === false) return 'mastercard_declined';
  return null;
}

export function validateDemoCard(fields: DemoCardFields, now = new Date()): DemoCardErrors {
  const errors: DemoCardErrors = {};
  const digits = cardDigits(fields.number);
  if (!fields.name.trim()) {
    errors.name = 'Enter the cardholder name.';
  }
  if (digits.length !== 16 || !detectCardBrand(digits)) {
    errors.number = 'Enter a supported 16-digit Visa or Mastercard test number.';
  } else if (!passesLuhn(digits)) {
    errors.number = 'Check the test card number and try again.';
  } else if (!SUPPORTED_CARD_NUMBERS.has(digits)) {
    errors.number = 'Use a supported synthetic test card.';
  }
  if (!validFutureExpiry(fields.expiry, now)) {
    errors.expiry = 'Enter a valid future expiry in MM/YY format.';
  }
  if (!/^\d{3}$/.test(fields.cvc)) {
    errors.cvc = 'Enter a 3-digit CVC.';
  }
  return errors;
}
