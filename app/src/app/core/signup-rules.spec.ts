/**
 * @file signup-rules.spec.ts
 * @description Unit tests for client-side signup password validation and feedback rules.
 */
import { describe, expect, it } from 'vitest';
import {
  hasEnoughDifferentCharacters,
  passwordContainsPersonalInfo,
  passwordHasLowercase,
  passwordHasNumber,
  passwordHasSpecialCharacter,
  passwordHasUppercase,
  passwordLengthIsValid,
  validateConfirmPassword,
  validatePassword,
} from './signup-rules';

describe('signup password policy', () => {
  it.each([
    ['', 'empty'],
    ['Aa1!xyz', 'short'],
    [`Aa1!${'x'.repeat(61)}`, 'long'],
    ['abcd123!', 'missing uppercase'],
    ['ABCD123!', 'missing lowercase'],
    ['Abcdefg!', 'missing number'],
    ['Abcdef12', 'missing special character'],
    ['Aaaaaaa1!', 'extremely repetitive'],
  ])('rejects %s as %s', (password) => {
    expect(validatePassword(password)).not.toBeNull();
  });

  it('accepts a password satisfying every condition', () => {
    expect(validatePassword('aB3!xY7@')).toBeNull();
    expect(passwordLengthIsValid('aB3!xY7@')).toBe(true);
    expect(passwordHasUppercase('aB3!xY7@')).toBe(true);
    expect(passwordHasLowercase('aB3!xY7@')).toBe(true);
    expect(passwordHasNumber('aB3!xY7@')).toBe(true);
    expect(passwordHasSpecialCharacter('aB3!xY7@')).toBe(true);
    expect(hasEnoughDifferentCharacters('aB3!xY7@')).toBe(true);
  });

  it('rejects common passwords that otherwise satisfy the character rules', () => {
    expect(validatePassword('Password1!')).not.toBeNull();
    expect(validatePassword('Araw-araw1')).not.toBeNull();
  });

  it('rejects personal information and recalculates when identity fields change', () => {
    const password = 'Maria7!Zebra';
    expect(validatePassword(password, { firstName: 'Liza' })).toBeNull();
    expect(validatePassword(password, { firstName: 'Maria' })).not.toBeNull();
    expect(validatePassword('Santos7!Zebra', { lastName: 'Santos' })).not.toBeNull();
    expect(validatePassword('CookieFan7!Z', { email: 'other@example.com' })).toBeNull();
    expect(validatePassword('CookieFan7!Z', { email: 'cookiefan@example.com' })).not.toBeNull();
    expect(passwordContainsPersonalInfo(password, '', 'Maria', '')).toBe(true);
  });

  it('allows spaces and Unicode characters', () => {
    expect(validatePassword('Buko pie7!')).toBeNull();
    expect(validatePassword('Buko7!雪花')).toBeNull();
  });

  it('requires the confirmation to match exactly', () => {
    expect(validateConfirmPassword('aB3!xY7@', 'aB3!xY7@')).toBeNull();
    expect(validateConfirmPassword('aB3!xY7@', 'aB3!xY7!')).not.toBeNull();
  });
});
