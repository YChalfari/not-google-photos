import { Capacitor } from '@capacitor/core';
import { PhotoSync, type DeviceConnection } from '@ngp/photo-sync';

/**
 * The installed app loads from http://localhost and must send the device token.
 * A dev WebView pointed at the Vite server (`CAP_SERVER_URL`) keeps using the
 * proxied `/api` cookie session, because that origin is not the bundled shell.
 */
export function isNativeApp(): boolean {
  return Capacitor.isNativePlatform();
}

export function usesDeviceAuth(): boolean {
  return isNativeApp() && window.location.hostname === 'localhost';
}

let current: DeviceConnection | null = null;

let launchReady = !usesDeviceAuth();
const launchListeners = new Set<() => void>();

/** False until the cold-start URL, if any, has been handled. */
export function isLaunchFinished(): boolean {
  return launchReady;
}

export function subscribeLaunch(listener: () => void): () => void {
  launchListeners.add(listener);
  return () => launchListeners.delete(listener);
}

export function finishLaunch(): void {
  if (launchReady) return;
  launchReady = true;
  for (const listener of launchListeners) listener();
}

/** The address the phone last resolved, including a saved one that did not answer. */
export function deviceServerAddress(): string | null {
  return current?.baseUrl ?? null;
}

/** Stores the token in module memory only. Returns whether the phone is paired. */
export async function refreshDeviceConnection(): Promise<boolean> {
  if (!usesDeviceAuth()) {
    current = null;
    return false;
  }
  const next = await PhotoSync.getConnection();
  if (!next?.baseUrl || !next.token) {
    current = null;
    return false;
  }
  current = {
    baseUrl: next.baseUrl.replace(/\/+$/, ''),
    token: next.token,
    serverId: next.serverId,
  };
  return true;
}

export async function clearDeviceConnection(): Promise<void> {
  if (isNativeApp()) await PhotoSync.configure({ deviceToken: '' });
  current = null;
}

/** Joins a root-relative API or media path onto a server address, keeping any path prefix. */
export function joinServerPath(baseUrl: string, path: string): string {
  const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  const relative = path.startsWith('/') ? path.slice(1) : path;
  return new URL(relative, base).href;
}

/** Prefixes a server path inside the bundled app. Absolute and data URLs pass through. */
export function assetUrl(path: string | null | undefined): string | undefined {
  if (!path) return undefined;
  if (!current || !path.startsWith('/')) return path;
  return joinServerPath(current.baseUrl, path);
}

export function nativeFetchParts(
  path: string,
  headers: Headers,
): { url: string; credentials: RequestCredentials } {
  if (!current) return { url: path, credentials: 'include' };
  headers.set('Authorization', `Bearer ${current.token}`);
  return { url: joinServerPath(current.baseUrl, path), credentials: 'omit' };
}
