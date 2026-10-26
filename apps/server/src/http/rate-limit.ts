import { ApiError } from './errors';

/** Fixed-window, in-memory limiter. One server process, so memory is enough. */
export class RateLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();

  constructor(
    readonly limit: number,
    readonly windowMs: number,
  ) {}

  consume(key: string, now = Date.now()): { ok: boolean; retryAfterSeconds: number } {
    if (this.hits.size > 10_000) this.prune(now);
    let entry = this.hits.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + this.windowMs };
      this.hits.set(key, entry);
    }
    entry.count += 1;
    return {
      ok: entry.count <= this.limit,
      retryAfterSeconds: Math.max(1, Math.ceil((entry.resetAt - now) / 1000)),
    };
  }

  reset(key: string): void {
    this.hits.delete(key);
  }

  private prune(now: number): void {
    for (const [key, entry] of this.hits) if (entry.resetAt <= now) this.hits.delete(key);
  }
}

export interface RateLimits {
  /** Per IP + email: wrong passwords. */
  login: RateLimiter;
  /** Per IP: login, pairing, setup, and invite attempts combined. */
  ip: RateLimiter;
  pairing: RateLimiter;
  invites: RateLimiter;
}

export function createRateLimits(overrides: Partial<Record<keyof RateLimits, number>> = {}): RateLimits {
  const fifteenMinutes = 15 * 60 * 1000;
  return {
    login: new RateLimiter(overrides.login ?? 10, fifteenMinutes),
    ip: new RateLimiter(overrides.ip ?? 100, fifteenMinutes),
    pairing: new RateLimiter(overrides.pairing ?? 20, fifteenMinutes),
    invites: new RateLimiter(overrides.invites ?? 30, fifteenMinutes),
  };
}

/** Throws `rate_limited` (429 with Retry-After) once the key is over its limit. */
export function enforceRateLimit(limiter: RateLimiter, key: string): void {
  const { ok, retryAfterSeconds } = limiter.consume(key);
  if (ok) return;
  const minutes = Math.ceil(retryAfterSeconds / 60);
  throw new ApiError(
    'rate_limited',
    `Too many attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`,
    { headers: { 'Retry-After': String(retryAfterSeconds) }, details: { retryAfterSeconds } },
  );
}
