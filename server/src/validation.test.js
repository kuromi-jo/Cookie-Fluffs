/**
 * @file validation.test.js
 * @description Unit tests for signup and profile validation rules.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  joinName,
  normalizePhone,
  splitFullName,
  validateDateOfBirth,
  validateEmail,
  validateFirstName,
  validateFullName,
  validateGender,
  validateLastName,
  validatePassword,
  validatePhone,
} from './validation.js';

test('splits and joins display names', () => {
  assert.deepEqual(splitFullName('Maria Santos'), { firstName: 'Maria', lastName: 'Santos' });
  assert.deepEqual(splitFullName('Maria Luisa Santos'), { firstName: 'Maria Luisa', lastName: 'Santos' });
  assert.deepEqual(splitFullName('Cher'), { firstName: 'Cher', lastName: '' });
  assert.deepEqual(splitFullName('  Maria   Luisa   Santos  '), { firstName: 'Maria Luisa', lastName: 'Santos' });
  assert.equal(joinName(' Maria Luisa ', ' Santos '), 'Maria Luisa Santos');
  assert.equal(joinName('Cher', ''), 'Cher');
});

test('validates first and last names', () => {
  assert.equal(validateFirstName('Maria'), null);
  assert.equal(validateLastName('De la Cruz'), null);
  assert.equal(validateLastName('Santos Jr.'), null);
  for (const name of ['A', '<script>', '12', 'A'.repeat(41)]) {
    assert.notEqual(validateFirstName(name), null);
    assert.notEqual(validateLastName(name), null);
  }
});

test('valid and invalid full names', () => {
  assert.equal(validateFullName("Ma. Luisa O'Neil-Peñafiel"), null);
  assert.notEqual(validateFullName('A'), null);
  assert.notEqual(validateFullName('<script>'), null);
  assert.notEqual(validateFullName('12'), null);
});

test('valid and invalid email addresses', () => {
  assert.equal(validateEmail(' Person@Example.com '), null);
  assert.notEqual(validateEmail('not-an-email'), null);
  assert.notEqual(validateEmail('name@'), null);
});

test('normalizes Philippine mobile numbers', () => {
  for (const phone of ['0917 123 4567', '+63 917 123 4567', '639171234567', '09171234567']) {
    assert.equal(normalizePhone(phone), '+639171234567');
  }
  for (const phone of ['12345', '0817 123 4567', '-------']) assert.equal(normalizePhone(phone), null);
  assert.equal(validatePhone('0917 123 4567'), null);
});

test('validates optional gender (empty allowed, enum enforced)', () => {
  for (const value of [null, undefined, '']) assert.equal(validateGender(value), null);
  for (const value of ['female', 'male', 'non_binary', 'prefer_not_to_say']) assert.equal(validateGender(value), null);
  assert.notEqual(validateGender('other'), null);
  assert.notEqual(validateGender('M'), null);
});

test('validates optional date of birth (empty allowed, real past calendar dates only)', () => {
  for (const value of [null, undefined, '']) assert.equal(validateDateOfBirth(value), null);
  assert.equal(validateDateOfBirth('1998-05-20'), null);
  assert.notEqual(validateDateOfBirth('2020-02-30'), null); // impossible day
  assert.notEqual(validateDateOfBirth('1998/05/20'), null); // wrong format
  assert.notEqual(validateDateOfBirth('1850-01-01'), null); // below sane range
  const nextYear = `${new Date().getUTCFullYear() + 1}-01-01`;
  assert.notEqual(validateDateOfBirth(nextYear), null); // future
});

test('enforces password length and required character classes', () => {
  assert.notEqual(validatePassword(''), null);
  assert.notEqual(validatePassword('Aa1!xyz'), null);
  assert.notEqual(validatePassword(`Aa1!${'x'.repeat(61)}`), null);
  assert.notEqual(validatePassword(`Aa1!${'ñ'.repeat(35)}`), null);
  assert.notEqual(validatePassword('abcd123!'), null);
  assert.notEqual(validatePassword('ABCD123!'), null);
  assert.notEqual(validatePassword('Abcdefg!'), null);
  assert.notEqual(validatePassword('Abcdef12'), null);
  assert.equal(validatePassword('aB3!xY7@'), null);
});

test('rejects personal, common, and extremely repetitive passwords', () => {
  assert.notEqual(validatePassword('CookieFan7!Z', { email: 'cookiefan@example.com' }), null);
  assert.notEqual(validatePassword('Maria7!Zebra', { firstName: 'Maria' }), null);
  assert.notEqual(validatePassword('Santos7!Zebra', { lastName: 'Santos' }), null);
  assert.notEqual(validatePassword('Aaaaaaa1!'), null);
  assert.notEqual(validatePassword('Password1!'), null);
});

test('allows spaces and Unicode without changing password characters', () => {
  assert.equal(validatePassword('Buko pie7!'), null);
  assert.equal(validatePassword('Buko7!雪花'), null);
});
