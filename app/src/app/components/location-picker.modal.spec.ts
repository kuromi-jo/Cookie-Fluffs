/**
 * @file location-picker.modal.spec.ts
 * @description Location-sheet sizing and searchable-option regression tests.
 */
import { describe, expect, it } from 'vitest';
import {
  LOCATION_SHEET_BREAKPOINTS,
  LOCATION_SHEET_INITIAL_BREAKPOINT,
  LocationPickerModalComponent,
} from './location-picker.modal';

describe('location picker sheet', () => {
  it('uses one natural-height sheet breakpoint rather than a near-full-height snap point', () => {
    expect(LOCATION_SHEET_BREAKPOINTS).toEqual([0, 1]);
    expect(LOCATION_SHEET_INITIAL_BREAKPOINT).toBe(1);
  });

  it('filters city and barangay labels without changing the source options', () => {
    const picker = new LocationPickerModalComponent();
    picker.options = [
      { code: '1', name: 'Quezon City' },
      { code: '2', name: 'Makati City' },
    ];
    picker.query.set('makati');
    expect(picker.filtered()).toEqual([{ code: '2', name: 'Makati City' }]);
    picker.query.set('');
    expect(picker.filtered()).toHaveLength(2);
  });
});
