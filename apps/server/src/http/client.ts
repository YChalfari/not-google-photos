import { getConnInfo } from '@hono/node-server/conninfo';
import type { Context } from 'hono';
import type { Env } from '../env';
import { ApiError } from './errors';

type ProxyEnv = Pick<Env, 'TRUST_PROXY'>;

/**
 * The caller's IP, for rate limits and the device list. With TRUST_PROXY, forwarded headers win;
 * any client that reaches the server directly can set them too, so only use this for limits and
 * display, never for access decisions.
 */
export function clientIp(c: Context, env: ProxyEnv): string {
  if (env.TRUST_PROXY) {
    const forwarded =
      c.req.header('cf-connecting-ip') ??
      c.req.header('x-forwarded-for')?.split(',').pop()?.trim() ??
      c.req.header('x-real-ip');
    if (forwarded) return forwarded;
  }
  try {
    return getConnInfo(c).remote.address ?? 'unknown';
  } catch {
    // In-process requests (tests) have no socket.
    return 'unknown';
  }
}

/** Host the browser used, e.g. `photos.example.com` or `192.168.1.20:4810`. */
export function requestHost(c: Context, env: ProxyEnv): string {
  const forwarded = env.TRUST_PROXY ? c.req.header('x-forwarded-host')?.split(',')[0]?.trim() : undefined;
  return (forwarded ?? c.req.header('host') ?? new URL(c.req.url).host).toLowerCase();
}

export function requestProtocol(c: Context, env: ProxyEnv): 'http' | 'https' {
  const forwarded = env.TRUST_PROXY
    ? c.req.header('x-forwarded-proto')?.split(',')[0]?.trim().toLowerCase()
    : undefined;
  const protocol = forwarded ?? new URL(c.req.url).protocol.replace(':', '');
  return protocol === 'https' ? 'https' : 'http';
}

/** `http(s)://host[:port]` as seen by the client. */
export function requestOrigin(c: Context, env: ProxyEnv): string {
  return `${requestProtocol(c, env)}://${requestHost(c, env)}`;
}

export function isLoopbackOrigin(origin: string): boolean {
  try {
    const { hostname } = new URL(origin);
    return hostname === 'localhost' || hostname === '::1' || hostname === '[::1]' || hostname.startsWith('127.');
  } catch {
    return false;
  }
}

/**
 * Cookie-authenticated writes must come from our own pages. Requests without an `Origin` header
 * are not from a browser form or script on another site, so they pass.
 */
export function assertSameOrigin(c: Context, env: ProxyEnv): void {
  const fetchSite = c.req.header('sec-fetch-site');
  if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') {
    throw new ApiError('forbidden', 'Cross-site requests are not allowed');
  }
  const origin = c.req.header('origin');
  if (!origin) return;
  let host: string | undefined;
  try {
    host = origin === 'null' ? undefined : new URL(origin).host.toLowerCase();
  } catch {
    host = undefined;
  }
  if (host !== requestHost(c, env)) {
    throw new ApiError('forbidden', 'Cross-site requests are not allowed');
  }
}
