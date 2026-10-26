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

export const GENDER_VALUES = Object.freeze(['female', 'male', 'non_binary', 'prefer_not_to_say']);

/** Validates the optional gender field. null/empty clears it; otherwise it must be an allowed value. */
export function validateGender(value) {
  if (value === null || value === undefined || value === '') return null;
  return GENDER_VALUES.includes(value) ? null : 'Choose one of the listed options for gender.';
}

/**
 * Validates the optional date of birth. null/empty clears it. Otherwise it must be a real
 * calendar date in YYYY-MM-DD form, not in the future, and within a sane range.
 */
export function validateDateOfBirth(value) {
  if (value === null || value === undefined || value === '') return null;
  const text = String(value).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return 'Enter your date of birth as YYYY-MM-DD.';
  const [year, month, day] = text.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  // Reject impossible calendar dates (e.g. 2026-02-30 would roll over).
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return 'Enter a real calendar date.';
  }
  const today = new Date();
  const todayUtc = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  if (date.getTime() > todayUtc) return 'Date of birth cannot be in the future.';
  if (year < 1900) return 'Enter a valid date of birth.';
  return null;
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
