/**
 * @file address.service.spec.ts
 * @description Saved-address API request and state tests.
 */
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AddressService } from './address.service';
import { SavedAddress } from './models';

const address = { id: 'address-1', label: 'Home', isDefault: true } as SavedAddress;
const input = {
  label: 'Home', recipientName: 'Maria Santos', recipientPhone: '+639171234567',
  addressLine1: '12 Cookie Street', addressLine2: '', cityCode: '1381300000',
  barangayCode: '1381300001', postalCode: '1100',
};

describe('AddressService', () => {
  let service: AddressService;
  let http: HttpTestingController;
  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
    service = TestBed.inject(AddressService);
    http = TestBed.inject(HttpTestingController);
  });
  afterEach(() => http.verify());

  it('loads the authenticated address collection', async () => {
    const promise = service.load();
    http.expectOne('/api/addresses').flush({ addresses: [address] });
    await expect(promise).resolves.toEqual([address]);
    expect(service.addresses()).toEqual([address]);
  });

  it('creates an address then refreshes persisted state', async () => {
    const promise = service.create({ ...input, makeDefault: true });
    const create = http.expectOne('/api/addresses');
    expect(create.request.method).toBe('POST');
    create.flush(address);
    await expect(promise).resolves.toEqual(address);
    expect(service.addresses()).toEqual([address]);
  });

  it('sets default and deletes through owner-scoped resource URLs', async () => {
    const set = service.setDefault(address.id);
    http.expectOne('/api/addresses/address-1/default').flush(address);
    await set;
    const remove = service.delete(address.id);
    http.expectOne('/api/addresses/address-1').flush(null);
    await remove;
  });
});
