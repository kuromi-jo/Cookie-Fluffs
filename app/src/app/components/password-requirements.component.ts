/**
 * @file password-requirements.component.ts
 * @description Shared live password-policy checklist for customer authentication forms.
 */
import { Component, computed, input } from '@angular/core';
import { IonIcon } from '@ionic/angular';
import {
  hasEnoughDifferentCharacters,
  passwordContainsPersonalInfo,
  passwordHasLowercase,
  passwordHasNumber,
  passwordHasSpecialCharacter,
  passwordHasUppercase,
  passwordIsNotCommon,
  passwordLengthIsValid,
} from '../core/signup-rules';

interface PasswordRequirement {
  label: string;
  met: boolean;
  advisory?: boolean;
}

@Component({
  selector: 'app-password-requirements',
  templateUrl: 'password-requirements.component.html',
  styleUrls: ['password-requirements.component.scss'],
  imports: [IonIcon],
})
export class PasswordRequirementsComponent {
  readonly password = input('');
  readonly email = input('');
  readonly firstName = input('');
  readonly lastName = input('');
  readonly identityKnown = input(false);

  readonly requirements = computed<PasswordRequirement[]>(() => {
    const password = this.password();
    const identityKnown = this.identityKnown();
    return [
      { label: '8–64 characters and no more than 72 bytes', met: passwordLengthIsValid(password) },
      { label: 'One uppercase letter', met: passwordHasUppercase(password) },
      { label: 'One lowercase letter', met: passwordHasLowercase(password) },
      { label: 'One number', met: passwordHasNumber(password) },
      { label: 'One special character', met: passwordHasSpecialCharacter(password) },
      {
        label: 'Not a common or easy-to-guess password',
        met: hasEnoughDifferentCharacters(password) && passwordIsNotCommon(password),
      },
      {
        label: identityKnown ? 'Does not contain your name or email' : 'Do not include your name or email',
        met: identityKnown && password.length > 0 && !passwordContainsPersonalInfo(
          password,
          this.email(),
          this.firstName(),
          this.lastName(),
        ),
        advisory: !identityKnown,
      },
    ];
  });
}
