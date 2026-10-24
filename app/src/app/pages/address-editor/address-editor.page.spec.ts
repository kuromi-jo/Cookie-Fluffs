/**
 * @file address-editor.page.spec.ts
 * @description Saved-address form validation tests.
 */
import { describe, expect, it } from 'vitest';
import { AddressDraft, validateAddressDraft } from './address-editor.page';

const valid: AddressDraft = {
  label: 'Home', recipientName: 'Maria Santos', recipientPhone: '0917 123 4567',
  addressLine1: '12 Cookie Street', addressLine2: '', cityCode: '1381300000',
  barangayCode: '1381300001', postalCode: '1100', makeDefault: true,
};

describe('saved address validation', () => {
  it('accepts a complete NCR address draft', () => expect(validateAddressDraft(valid)).toEqual({}));
  it('rejects invalid contact and delivery details', () => {
    expect(validateAddressDraft({ ...valid, recipientPhone: '123', cityCode: '', postalCode: '11' }))
      .toEqual(expect.objectContaining({ recipientPhone: expect.any(String), cityCode: expect.any(String), postalCode: expect.any(String) }));
  });
  it('accepts Home, Work, and bounded custom labels', () => {
    expect(validateAddressDraft({ ...valid, label: 'Grandma' }).label).toBeUndefined();
  });
});
