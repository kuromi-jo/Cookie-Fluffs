/**
 * @file geography.service.ts
 * @description Loads and queries the server's versioned NCR PSGC snapshot.
 */
import { HttpClient } from '@angular/common/http';
import { Injectable, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { environment } from '../../environments/environment';

export interface GeographicOption {
  code: string;
  name: string;
}
export interface NcrCity extends GeographicOption {
  barangays: GeographicOption[];
}

export interface NcrGeography {
  version: string;
  source: string;
  sourceUrl: string;
  region: {
    code: string;
    correspondenceCode: string;
    name: string;
    provinceEquivalent: string;
  };
  cities: NcrCity[];
}

@Injectable({ providedIn: 'root' })
export class GeographyService {
  private http = inject(HttpClient);
  private request: Promise<void> | null = null;

  readonly data = signal<NcrGeography | null>(null);
  readonly loading = signal(false);
  readonly error = signal('');

  load(): Promise<void> {
    if (this.data()) return Promise.resolve();
    if (this.request) return this.request;
    this.loading.set(true);
    this.error.set('');
    this.request = firstValueFrom(this.http.get<NcrGeography>(`${environment.apiUrl}/geography/ncr`))
      .then((data) => {
        this.data.set(data);
      })
      .catch(() => {
        this.error.set('We couldn’t load NCR locations. Check your connection and try again.');
      })
      .finally(() => {
        this.loading.set(false);
        this.request = null;
      });
    return this.request;
  }

  city(code: string): NcrCity | undefined {
    return this.data()?.cities.find((city) => city.code === code);
  }

  barangays(code: string): GeographicOption[] {
    return this.city(code)?.barangays ?? [];
  }
}
