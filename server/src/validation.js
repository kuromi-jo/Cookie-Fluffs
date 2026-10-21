/**
 * @file validation.js
 * @description Pure input validators shared by authentication routes and tests.
 */
import { COMMON_PASSWORDS } from './common-passwords.js';

export const PASSWORD_POLICY = { minLength: 8, maxLength: 64 };
export const SUPPORTED_SPECIAL_CHARACTERS = `!"#$%&'()*+,-./:;<=>?@[\\]^_\`{|}~`;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const NAME_RE = /^\p{L}[\p{L}\p{M}' .\-]*$/u;
const PHONE_RE = /^(?:\+63|63|0)9\d{9}$/;

/** Splits a display name into first and last name parts. */
export function splitFullName(fullName) {
  const parts = String(fullName ?? '').trim().replace(/\s+/g, ' ').split(' ').filter(Boolean);
  if (parts.length <= 1) return { firstName: parts[0] ?? '', lastName: '' };
  return { firstName: parts.slice(0, -1).join(' '), lastName: parts.at(-1) };
}

/** Joins trimmed first and last name parts into one display name. */
export function joinName(firstName, lastName) {
  return [String(firstName ?? '').trim(), String(lastName ?? '').trim()].filter(Boolean).join(' ');
}

/** Validates a required first name. */
export function validateFirstName(value) {
  const name = String(value ?? '').trim();
  if (name.length < 2 || name.length > 40 || !NAME_RE.test(name)) {
    return 'Enter your first name using letters, 2 to 40 characters.';
  }
  return null;
}

/** Validates a required last name. */
export function validateLastName(value) {
  const name = String(value ?? '').trim();
  if (name.length < 2 || name.length > 40 || !NAME_RE.test(name)) {
    return 'Enter your last name using letters, 2 to 40 characters.';
  }
  return null;
}

/** Validates a legacy combined display name. */
export function validateFullName(value) {
  const name = String(value ?? '').trim();
  if (name.length < 2 || name.length > 60 || !NAME_RE.test(name)) {
    return 'Enter your full name using letters, 2 to 60 characters.';
  }
  return null;
}

export function validateEmail(value) {
  const email = String(value ?? '').trim().toLowerCase();
  if (email.length > 254 || !EMAIL_RE.test(email)) return 'Enter a valid email address, like name@example.com.';
  return null;
}

export function normalizePhone(value) {
  const phone = String(value ?? '').replace(/[\s\-()]/g, '');
  if (!PHONE_RE.test(phone)) return null;
  return `+639${phone.slice(-9)}`;
}

export function validatePhone(value) {
  return normalizePhone(value) ? null : 'Enter a Philippine mobile number, like 0917 123 4567.';
}

export function validatePassword(password, { email = '', firstName = '', lastName = '' } = {}) {
  const value = String(password ?? '');
  const characters = [...value];
  if (characters.length < PASSWORD_POLICY.minLength) return 'Password needs at least 8 characters.';
  if (characters.length > PASSWORD_POLICY.maxLength || Buffer.byteLength(value, 'utf8') > 72) {
    return 'Password must be 64 characters or fewer.';
  }

  if (!/[A-Z]/.test(value)) return 'Password needs at least one uppercase letter.';
  if (!/[a-z]/.test(value)) return 'Password needs at least one lowercase letter.';
  if (!/[0-9]/.test(value)) return 'Password needs at least one number.';
  if (!characters.some((character) => SUPPORTED_SPECIAL_CHARACTERS.includes(character))) {
    return 'Password needs at least one special character, like ! or @.';
  }

  const lowercase = value.toLowerCase();
  if (new Set(characters).size < 5 || COMMON_PASSWORDS.has(lowercase)) {
    return 'That password is too easy to guess. Try a longer phrase that is hard to guess.';
  }

  const emailLocal = String(email).trim().toLowerCase().split('@')[0];
  const compactFirstName = String(firstName).toLowerCase().replace(/\s/g, '');
  const compactLastName = String(lastName).toLowerCase().replace(/\s/g, '');
  if ((emailLocal.length >= 4 && lowercase.includes(emailLocal)) ||
      (compactFirstName.length >= 4 && lowercase.includes(compactFirstName)) ||
      (compactLastName.length >= 4 && lowercase.includes(compactLastName))) {
    return 'Password should not contain your name or email.';
  }
  return null;
}
