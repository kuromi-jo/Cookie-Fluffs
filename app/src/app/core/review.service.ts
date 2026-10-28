/**
 * @file review.service.ts
 * @description Cookie reviews and the order tracker map points: rate cookies from a completed order,
 * read a cookie's public reviews, and load map points for an order.
 */
import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { environment } from '../../environments/environment';
import { MapPoint } from '../components/order-tracker-map.component';

export interface MyReview {
  rating: number;
  comment: string | null;
  /** Shown as "Anonymous customer" on the cookie page instead of the first name. */
  anonymous: boolean;
}

export interface ReviewableCookie {
  productId: number;
  name: string;
  imageUrl: string;
  review: MyReview | null;
}

export interface OrderReviews {
  canReview: boolean;
  items: ReviewableCookie[];
}

export interface ProductReview {
  id: string;
  rating: number;
  comment: string | null;
  name: string;
  createdAt: string;
}

export interface ProductReviews {
  average: number;
  count: number;
  reviews: ProductReview[];
}

export interface OrderTracking {
  kitchen: MapPoint;
  destination: MapPoint | null;
  fulfillment: 'delivery' | 'pickup';
  status: string;
}

@Injectable({ providedIn: 'root' })
export class ReviewService {
  private http = inject(HttpClient);
  private api = environment.apiUrl;

  forOrder(orderId: string): Promise<OrderReviews> {
    return firstValueFrom(this.http.get<OrderReviews>(`${this.api}/orders/${encodeURIComponent(orderId)}/reviews`));
  }

  submit(orderId: string, productId: number, rating: number, comment: string, anonymous: boolean): Promise<MyReview> {
    return firstValueFrom(
      this.http.post<MyReview>(`${this.api}/orders/${encodeURIComponent(orderId)}/reviews`, { productId, rating, comment, anonymous }),
    );
  }

  forProduct(productId: number): Promise<ProductReviews> {
    return firstValueFrom(this.http.get<ProductReviews>(`${this.api}/products/${productId}/reviews`));
  }

  tracking(orderId: string): Promise<OrderTracking> {
    return firstValueFrom(this.http.get<OrderTracking>(`${this.api}/orders/${encodeURIComponent(orderId)}/tracking`));
  }
}
