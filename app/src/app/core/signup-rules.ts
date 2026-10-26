/**
 * @file signup-rules.ts
 * @description Pure client-side rules for signup fields and password feedback.
 */

// Keep in sync with server/src/validation.js.
export const PASSWORD_POLICY = { minLength: 8, maxLength: 64 };
export const SUPPORTED_SPECIAL_CHARACTERS = `!"#$%&'()*+,-./:;<=>?@[\\]^_\`{|}~`;

const COMMON_POLICY_PASSWORDS = new Set([
  'password1', 'password2', 'password123', 'password!', 'passw0rd', 'pass1234', 'pass12345',
  'p@ssword1', 'qwerty123', 'qwertyui', 'qwerty12', 'qwerty1!', 'asdfghjk', 'asdf1234',
  'zxcvbnm1', 'zxcvbn12', 'letmein1', 'letmein12', 'welcome1', 'welcome12', 'welcome123',
  'admin123', 'admin1234', 'administrator', 'root12345', 'login123', 'login1234', 'user1234',
  'abc12345', 'abc123456', 'abcd1234', 'abcdefghi', 'abcdefgh', '12345678', '123456789',
  '1234567890', '1234567a', '12345678a', '87654321', '11111111', '111111111', '11111111a',
  '00000000', '000000000', '00000001', '22222222', '33333333', '44444444', '55555555',
  '66666666', '77777777', '88888888', '99999999', 'iloveyou', 'iloveyou1', 'loveyou123',
  'sunshine1', 'sunshine', 'princess1', 'princess12', 'football1', 'football12', 'baseball1',
  'soccer123', 'basketball', 'charlie123', 'monkey123', 'dragon123', 'master123', 'shadow123',
  'superman1', 'batman123', 'trustno1', 'whatever1', 'freedom1', 'starwars1', 'pokemon123',
  'minecraft', 'minecraft1', 'internet1', 'computer1', 'whatever123', 'secret123', 'secret12',
  'cheese123', 'summer123', 'winter123', 'spring123', 'autumn123', 'orange123', 'flower123',
  'hannah123', 'jessica1', 'jennifer1', 'michael1', 'michelle1', 'andrew123', 'thomas123',
  'jordan123', 'william1', 'charles1', 'george123', 'samantha1', 'qazwsxedc', 'qazwsx12',
  '1q2w3e4r', '1qaz2wsx', '1q2w3e4r5t', 'asdfgh123', 'asdfghjkl', 'poiuytrewq', 'mnbvcxz1',
  'passw0rd1', 'password01', 'password12', 'password2024', 'password2025', 'password2026',
  'changeme1', 'changeme12', 'newpassword', 'temporary1', 'testing123', 'test12345', 'testtest',
  'guest123', 'default1', 'default123', 'backup123', 'service123', 'support123', 'office123',
  'company123', 'manager1', 'manager12', 'access123', 'access12', 'welcome!', 'hello1234',
  'hello123', 'helloworld', 'goodluck1', 'goodmorning', 'goodnight1', 'beautiful1', 'lovely123',
  'nothing1', 'nothing123', 'nopassword', 'secretpass', 'mysecret1', 'myself123', 'whatever1',
  'cookiefluffs', 'cookiefluffs1', 'cookies123', 'ilovecookies', 'cookie1234', 'cookies12',
  'cookiemonster', 'chocolate1', 'chocolate12', 'chocochip1', 'bake12345', 'bakery123',
  'sweettooth', 'sweet1234', 'sweettreat', 'treat1234', 'dessert123', 'cupcake123', 'brownie1',
  'pilipinas', 'pilipinas1', 'philippines', 'philippines1', 'manila123', 'manila2024',
  'manila2025', 'manila2026', 'quezoncity', 'quezon123', 'mahalkita', 'mahal1234', 'kumustaka',
  'kumusta123', 'jollibee1', 'jollibee123', 'pinoy1234', 'pinoypride', 'tagalog123', 'makati123',
  'pasig1234', 'baguio123', 'boracay12', 'palawan123', 'mindanao1', 'luzon1234', 'visayas123',
  'barangay1', 'kapamilya', 'kaibigan1', 'pamilya123', 'pagibig123', 'salamat123', 'mabuhay123',
  'magandang1', 'pinoypinoy', 'araw-araw1', 'bahaykubo', 'anak12345', 'ate123456', 'kuya12345',
  'school123', 'student1', 'student123', 'teacher1', 'teacher123', 'tipqc1234', 'itstudent1',
  'integrative', 'college123', 'university', 'classmate1', 'section123', 'project123',
  'ilovemanila', 'ilovepinas', 'filipino1', 'filipino123', 'pinoylife', 'tropangpinoy',
  'happy1234', 'happiness', 'smile1234', 'laugh1234', 'lovelife1', 'lifeisgood', 'godisgood1',
  'jesus123', 'blessed1', 'blessed123', 'faith1234', 'angel1234', 'heaven123', 'forever123',
  'nothing123', '12345678!', 'password1!', 'qwerty123!', 'welcome123!', 'admin123!', 'letmein1!',
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

export function passwordIsNotCommon(password: string): boolean {
  return password.length > 0 && !COMMON_POLICY_PASSWORDS.has(password.toLowerCase());
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
  if (!hasEnoughDifferentCharacters(value) || !passwordIsNotCommon(value)) {
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
