import type { Context } from 'hono';
import { resolveDeviceToken } from '../auth/devices';
import { resolveSession } from '../auth/sessions';
import type { AppContext } from '../context';
import type { DeviceRow, SessionRow, UserRow } from '../db/schema';
import { clientIp } from './client';
import { readSessionCookie, setSessionCookie } from './cookies';
import { ApiError } from './errors';
import type { AppEnv } from './types';

/** Who is calling: a browser session (cookie) or a paired device (bearer token). */
export type AuthContext =
  | { kind: 'session'; user: UserRow; session: SessionRow; device: null }
  | { kind: 'device'; user: UserRow; device: DeviceRow; session: null };

/**
 * Resolves the caller once per request. A bearer token that doesn't work is an error (the phone
 * needs to re-pair); a stale cookie just means signed out.
 */
export async function resolveAuth(c: Context<AppEnv>, ctx: AppContext): Promise<AuthContext | null> {
  const cached = c.get('auth');
  if (cached !== undefined) return cached;

  let auth: AuthContext | null = null;
  const header = c.req.header('authorization');
  if (header) {
    const match = /^Bearer\s+(\S+)$/i.exec(header);
    const resolved = match?.[1]
      ? await resolveDeviceToken(ctx.db, match[1], clientIp(c, ctx.env))
      : null;
    if (!resolved) {
      throw new ApiError('unauthorized', 'This device token is invalid or has been revoked. Pair the device again.', {
        headers: { 'WWW-Authenticate': 'Bearer error="invalid_token"' },
      });
    }
    auth = { kind: 'device', user: resolved.user, device: resolved.device, session: null };
  } else {
    const token = readSessionCookie(c);
    const resolved = token ? await resolveSession(ctx.db, token, ctx.env.SESSION_TTL_DAYS) : null;
    if (resolved && token) {
      auth = { kind: 'session', user: resolved.user, session: resolved.session, device: null };
      if (resolved.refreshed) setSessionCookie(c, ctx.env, token, resolved.session.expiresAt);
    }
  }
  c.set('auth', auth);
  return auth;
}
