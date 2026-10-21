/**
 * @file signup-rules.ts
 * @description Pure client-side rules for signup fields and password feedback.
 */

// Keep in sync with server/src/validation.js.
export const PASSWORD_POLICY = { minLength: 8, maxLength: 64 };
export const SUPPORTED_SPECIAL_CHARACTERS = `!"#$%&'()*+,-./:;<=>?@[\\]^_\`{|}~`;

const COMMON_POLICY_PASSWORDS = new Set([
  'p@ssword1',
  'qwerty1!',
  'password1!',
  'qwerty123!',
  'welcome123!',
  'admin123!',
  'letmein1!',
  'araw-araw1',
]);

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const NAME_RE = /^\p{L}[\p{L}\p{M}' .\-]*$/u;
const PHONE_RE = /^(?:\+63|63|0)9\d{9}$/;

export function validateFirstName(value: unknown): string | null {
  const name = String(value ?? '').trim();
  if (name.length < 2 || name.length > 40 || !NAME_RE.test(name)) {
    return 'Enter your first name using letters, 2 to 40 characters.';
  }
  return null;
}

export function validateLastName(value: unknown): string | null {
  const name = String(value ?? '').trim();
  if (name.length < 2 || name.length > 40 || !NAME_RE.test(name)) {
    return 'Enter your last name using letters, 2 to 40 characters.';
  }
  return null;
}

export function validateEmail(value: unknown): string | null {
  const email = String(value ?? '').trim().toLowerCase();
  if (email.length > 254 || !EMAIL_RE.test(email)) return 'Enter a valid email address, like name@example.com.';
  return null;
}

export function normalizePhone(value: unknown): string | null {
  const phone = String(value ?? '').replace(/[\s\-()]/g, '');
  if (!PHONE_RE.test(phone)) return null;
  return `+639${phone.slice(-9)}`;
}

export function validatePhone(value: unknown): string | null {
  return normalizePhone(value) ? null : 'Enter a Philippine mobile number, like 0917 123 4567.';
}

export function hasEnoughDifferentCharacters(password: string): boolean {
  return new Set([...password]).size >= 5;
}

export function passwordHasUppercase(password: string): boolean {
  return /[A-Z]/.test(password);
}

export function passwordHasLowercase(password: string): boolean {
  return /[a-z]/.test(password);
}

export function passwordHasNumber(password: string): boolean {
  return /[0-9]/.test(password);
}

export function passwordHasSpecialCharacter(password: string): boolean {
  return [...password].some((character) => SUPPORTED_SPECIAL_CHARACTERS.includes(character));
}

export function passwordLengthIsValid(password: string): boolean {
  const characterCount = [...password].length;
  return characterCount >= PASSWORD_POLICY.minLength &&
    characterCount <= PASSWORD_POLICY.maxLength &&
    new TextEncoder().encode(password).length <= 72;
}

export function passwordContainsPersonalInfo(password: string, email = '', firstName = '', lastName = ''): boolean {
  const lowercase = password.toLowerCase();
  const emailLocal = email.trim().toLowerCase().split('@')[0];
  const compactFirstName = firstName.toLowerCase().replace(/\s/g, '');
  const compactLastName = lastName.toLowerCase().replace(/\s/g, '');
  return (emailLocal.length >= 4 && lowercase.includes(emailLocal)) ||
    (compactFirstName.length >= 4 && lowercase.includes(compactFirstName)) ||
    (compactLastName.length >= 4 && lowercase.includes(compactLastName));
}

export function validatePassword(password: unknown, { email = '', firstName = '', lastName = '' } = {}): string | null {
  const value = String(password ?? '');
  const characterCount = [...value].length;
  if (characterCount < PASSWORD_POLICY.minLength) return 'Password needs at least 8 characters.';
  if (characterCount > PASSWORD_POLICY.maxLength || new TextEncoder().encode(value).length > 72) {
    return 'Password must be 64 characters or fewer.';
  }
  if (!passwordHasUppercase(value)) return 'Password needs at least one uppercase letter.';
  if (!passwordHasLowercase(value)) return 'Password needs at least one lowercase letter.';
  if (!passwordHasNumber(value)) return 'Password needs at least one number.';
  if (!passwordHasSpecialCharacter(value)) {
    return 'Password needs at least one special character, like ! or @.';
  }
  if (!hasEnoughDifferentCharacters(value) || COMMON_POLICY_PASSWORDS.has(value.toLowerCase())) {
    return 'That password is too easy to guess. Try a longer phrase that is hard to guess.';
  }
  if (passwordContainsPersonalInfo(value, email, firstName, lastName)) {
    return 'Password should not contain your name or email.';
  }
  return null;
}

export function validateConfirmPassword(password: string, confirmation: string): string | null {
  return confirmation && confirmation === password ? null : 'Passwords do not match.';
}
