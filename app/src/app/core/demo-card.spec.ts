/**
 * @file demo-card.spec.ts
 * @description Validation coverage for synthetic card formatting and allowlisting.
 */
import { describe, expect, it } from 'vitest';
import {
  DEMO_CARD_VALUES,
  demoCardFlow,
  demoScenarioForFlow,
  detectCardBrand,
  formatCardNumber,
  passesLuhn,
  validFutureExpiry,
  validateDemoCard,
} from './demo-card';

const valid = (number: string = DEMO_CARD_VALUES.visa_approved) => ({
  name: 'Maria Santos',
  number,
  expiry: '12/30',
  cvc: '123',
});

describe('card demo rules', () => {
  it('formats and recognizes the approved Visa and Mastercard', () => {
    expect(formatCardNumber(DEMO_CARD_VALUES.visa_approved)).toBe('4343 4343 4343 4345');
    expect(detectCardBrand(DEMO_CARD_VALUES.visa_approved)).toBe('Visa');
    expect(detectCardBrand(DEMO_CARD_VALUES.mastercard_approved)).toBe('Mastercard');
    expect(passesLuhn(DEMO_CARD_VALUES.visa_approved)).toBe(true);
    expect(passesLuhn(DEMO_CARD_VALUES.mastercard_approved)).toBe(true);
  });

  it('maps both approval cards and the direct decline without exposing card fields', () => {
    expect(demoCardFlow(valid(DEMO_CARD_VALUES.visa_approved))).toBe('approved');
    expect(demoCardFlow(valid(DEMO_CARD_VALUES.mastercard_approved))).toBe('approved');
    expect(demoCardFlow(valid(DEMO_CARD_VALUES.visa_declined))).toBe('declined');
    expect(demoScenarioForFlow('approved')).toBe('visa_approved');
    expect(demoScenarioForFlow('declined')).toBe('mastercard_declined');
  });

  it('requires an explicit simulated 3DS result before producing a terminal scenario', () => {
    expect(demoCardFlow(valid(DEMO_CARD_VALUES.visa_three_ds))).toBe('three_ds');
    expect(demoScenarioForFlow('three_ds')).toBeNull();
    expect(demoScenarioForFlow('three_ds', true)).toBe('visa_approved');
    expect(demoScenarioForFlow('three_ds', false)).toBe('mastercard_declined');
  });

  it('accepts flexible names, future expiry dates, and three-digit CVC values', () => {
    expect(validateDemoCard({ ...valid(), name: 'A. Test Customer', expiry: '11/31', cvc: '907' }, new Date('2026-10-24'))).toEqual({});
    expect(validFutureExpiry('10/26', new Date('2026-10-24'))).toBe(true);
    expect(validFutureExpiry('09/26', new Date('2026-10-24'))).toBe(false);
  });

  it('rejects unknown cards, expired dates, malformed CVCs, and blank names', () => {
    expect(validateDemoCard(valid('4242424242424242'), new Date('2026-10-23')).number).toContain('supported');
    expect(validateDemoCard({ ...valid(), expiry: '01/20' }, new Date('2026-10-23')).expiry).toContain('future');
    expect(validateDemoCard({ ...valid(), cvc: '12A' }, new Date('2026-10-23')).cvc).toContain('3-digit');
    expect(validateDemoCard({ ...valid(), name: '   ' }, new Date('2026-10-23')).name).toContain('name');
  });
});
