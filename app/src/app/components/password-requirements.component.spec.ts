/**
 * @file password-requirements.component.spec.ts
 * @description Shared password checklist parity and personal-information tests.
 */
import { describe, expect, it } from 'vitest';
import { PasswordRequirementsComponent } from './password-requirements.component';

describe('PasswordRequirementsComponent', () => {
  it('declares every server-enforced password requirement', () => {
    const source = PasswordRequirementsComponent.toString();
    expect(source).toContain('passwordLengthIsValid');
    expect(source).toContain('passwordHasUppercase');
    expect(source).toContain('passwordHasLowercase');
    expect(source).toContain('passwordHasNumber');
    expect(source).toContain('passwordHasSpecialCharacter');
    expect(source).toContain('passwordIsNotCommon');
    expect(source).toContain('hasEnoughDifferentCharacters');
    expect(source).toContain('passwordContainsPersonalInfo');
  });
});
