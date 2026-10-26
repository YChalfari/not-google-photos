import { SESSION_COOKIE } from '@ngp/shared';
import type { Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { Env } from '../env';
import { requestProtocol } from './client';

type CookieEnv = Pick<Env, 'COOKIE_SECURE' | 'TRUST_PROXY'>;

function isSecure(c: Context, env: CookieEnv): boolean {
  if (env.COOKIE_SECURE === 'always') return true;
  if (env.COOKIE_SECURE === 'never') return false;
  return requestProtocol(c, env) === 'https';
}

export function readSessionCookie(c: Context): string | undefined {
  return getCookie(c, SESSION_COOKIE);
}

export function setSessionCookie(c: Context, env: CookieEnv, token: string, expiresAt: Date): void {
  setCookie(c, SESSION_COOKIE, token, {
    path: '/',
    httpOnly: true,
    sameSite: 'Lax',
    secure: isSecure(c, env),
    expires: expiresAt,
  });
}

export function clearSessionCookie(c: Context, env: CookieEnv): void {
  deleteCookie(c, SESSION_COOKIE, { path: '/', httpOnly: true, sameSite: 'Lax', secure: isSecure(c, env) });
}
