/**
 * @file photo.pipe.ts
 * @description `[src]="url | cfPhoto | async"` makes admin-uploaded product photos show everywhere.
 * Bundled photos (assets/...) and photos on a same-origin API (web, dev proxy) pass straight through.
 * When the API is a separate HTTPS origin (the Android app talks to it through ngrok), an <img> tag
 * cannot send the ngrok bypass header, so the photo is fetched with HttpClient (the auth interceptor
 * adds the header) and shown from a cached object URL.
 */
import { Injectable, Pipe, PipeTransform, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, catchError, map, of, shareReplay } from 'rxjs';
import { environment } from '../../environments/environment';

const UPLOADED_PHOTO_RE = /^\/api\/products\/\d+\/image(\?v=\d+)?$/;

@Injectable({ providedIn: 'root' })
export class PhotoService {
  private http = inject(HttpClient);
  private readonly cache = new Map<string, Observable<string>>();
  /** e.g. https://example.ngrok-free.dev when the API is on another origin; null for '/api'. */
  private readonly apiOrigin = /^https?:\/\//.test(environment.apiUrl) ? new URL(environment.apiUrl).origin : null;

  resolve(url: string | null | undefined): Observable<string | null> {
    if (!url || !this.apiOrigin || !UPLOADED_PHOTO_RE.test(url)) return of(url ?? null);
    let photo = this.cache.get(url);
    if (!photo) {
      photo = this.http.get(this.apiOrigin + url, { responseType: 'blob' }).pipe(
        map((blob) => URL.createObjectURL(blob)),
        catchError(() => of(this.apiOrigin + url)),
        shareReplay(1),
      );
      this.cache.set(url, photo);
    }
    return photo;
  }
}

@Pipe({ name: 'cfPhoto' })
export class PhotoPipe implements PipeTransform {
  private photos = inject(PhotoService);

  transform(url: string | null | undefined): Observable<string | null> {
    return this.photos.resolve(url);
  }
}
