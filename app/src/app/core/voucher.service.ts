/**
 * @file voucher.service.ts
 * @description The customer's vouchers and checkout price previews. The server decides every discount.
 */
import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { environment } from '../../environments/environment';
import { FulfillmentMethod, Voucher, VoucherPreview } from './models';

@Injectable({ providedIn: 'root' })
export class VoucherService {
  private http = inject(HttpClient);
  private base = `${environment.apiUrl}/vouchers`;

  async list(): Promise<Voucher[]> {
    const response = await firstValueFrom(this.http.get<{ vouchers: Voucher[] }>(this.base));
    return response.vouchers;
  }

  preview(code: string, fulfillmentMethod: FulfillmentMethod): Promise<VoucherPreview> {
    return firstValueFrom(this.http.post<VoucherPreview>(`${this.base}/preview`, {
      code: code.trim().toUpperCase(),
      fulfillmentMethod,
    }));
  }
}
