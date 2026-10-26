import { createHmac, timingSafeEqual } from 'node:crypto';
import type { MediaVariant } from '@ngp/shared';

export interface MediaUrlRequest {
  assetId: string;
  variant: MediaVariant;
  /** The person the URL is issued to; access is re-checked for them on every request. */
  userId: string;
}

export interface SignedUrl {
  url: string;
  expiresAt: Date;
}

/**
 * Signs short-lived media URLs that work in `<img>` and `<video>` without cookies or tokens.
 *
 * Expiry is rounded to fixed windows so the same URL is reused for a while and the browser cache
 * keeps working: a URL stays valid for between `ttlSeconds / 2` and `ttlSeconds`.
 */
export class MediaSigner {
  private readonly windowSeconds: number;

  constructor(
    private readonly secret: string,
    private readonly ttlSeconds: number,
  ) {
    this.windowSeconds = Math.max(30, Math.floor(ttlSeconds / 2));
  }

  private signature(request: MediaUrlRequest, exp: number): string {
    return createHmac('sha256', this.secret)
      .update(`media:v1:${request.assetId}:${request.variant}:${request.userId}:${exp}`)
      .digest('base64url')
      .slice(0, 32);
  }

  sign(request: MediaUrlRequest, now = Date.now()): SignedUrl {
    const nowSeconds = Math.floor(now / 1000);
    const exp =
      Math.ceil((nowSeconds + this.windowSeconds) / this.windowSeconds) * this.windowSeconds;
    const params = new URLSearchParams({
      exp: String(exp),
      uid: request.userId,
      sig: this.signature(request, exp),
    });
    return {
      url: `/api/media/${request.assetId}/${request.variant}?${params.toString()}`,
      expiresAt: new Date(exp * 1000),
    };
  }

  verify(
    request: MediaUrlRequest & { exp: number; sig: string },
    now = Date.now(),
  ): 'ok' | 'expired' | 'invalid' {
    const expected = Buffer.from(this.signature(request, request.exp));
    const actual = Buffer.from(request.sig);
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return 'invalid';
    if (request.exp * 1000 <= now) return 'expired';
    return 'ok';
  }
}
