/**
 * @file address.service.ts
 * @description Authenticated saved-address API state and mutations.
 */
import { HttpClient } from '@angular/common/http';
import { Injectable, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { environment } from '../../environments/environment';
import { SavedAddress, SavedAddressInput } from './models';

@Injectable({ providedIn: 'root' })
export class AddressService {
  private http = inject(HttpClient);
  private base = `${environment.apiUrl}/addresses`;

  readonly addresses = signal<SavedAddress[]>([]);

  private ordered(addresses: SavedAddress[]): SavedAddress[] {
    return [...addresses].sort((left, right) => Number(right.isDefault) - Number(left.isDefault)
      || right.updatedAt.localeCompare(left.updatedAt));
  }

  async load(): Promise<SavedAddress[]> {
    const response = await firstValueFrom(this.http.get<{ addresses: SavedAddress[] }>(this.base));
    this.addresses.set(response.addresses);
    return response.addresses;
  }

  async create(input: SavedAddressInput & { makeDefault?: boolean }): Promise<SavedAddress> {
    const address = await firstValueFrom(this.http.post<SavedAddress>(this.base, input));
    this.addresses.update((current) => this.ordered([
      ...current.map((entry) => address.isDefault ? { ...entry, isDefault: false } : entry),
      address,
    ]));
    return address;
  }

  async update(id: string, input: SavedAddressInput): Promise<SavedAddress> {
    const address = await firstValueFrom(this.http.put<SavedAddress>(`${this.base}/${id}`, input));
    this.addresses.update((current) => this.ordered(current.map((entry) => entry.id === id ? address : entry)));
    return address;
  }

  async setDefault(id: string): Promise<SavedAddress> {
    const address = await firstValueFrom(this.http.put<SavedAddress>(`${this.base}/${id}/default`, {}));
    this.addresses.update((current) => this.ordered(current.map((entry) => ({
      ...entry,
      isDefault: entry.id === id,
      updatedAt: entry.id === id ? address.updatedAt : entry.updatedAt,
    }))));
    return address;
  }

  async delete(id: string): Promise<void> {
    await firstValueFrom(this.http.delete<void>(`${this.base}/${id}`));
    this.addresses.update((current) => {
      const deletedWasDefault = current.some((entry) => entry.id === id && entry.isDefault);
      const remaining = current.filter((entry) => entry.id !== id);
      if (deletedWasDefault && remaining.length) {
        const newest = [...remaining].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
        return this.ordered(remaining.map((entry) => ({ ...entry, isDefault: entry.id === newest.id })));
      }
      return this.ordered(remaining);
    });
  }
}
