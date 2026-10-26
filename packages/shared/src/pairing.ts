import { z } from 'zod';
import { PAIRING_CODE_LENGTH, PAIRING_URI_SCHEME } from './constants';
import { BaseUrl, Id, IsoDateTime } from './primitives';

/** Crockford base32: no I, L, O, or U, so codes are easy to read out and type. */
export const PAIRING_CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** Upper-cases, strips separators, and maps look-alike letters (O to 0, I and L to 1). */
export function normalizePairingCode(input: string): string {
  return input
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
}

/** `ABCDE12345` becomes `ABCDE-12345` for display. */
export function formatPairingCode(code: string): string {
  const normalized = normalizePairingCode(code);
  const half = Math.ceil(normalized.length / 2);
  return `${normalized.slice(0, half)}-${normalized.slice(half)}`;
}

const codePattern = new RegExp(`^[${PAIRING_CODE_ALPHABET}]{${PAIRING_CODE_LENGTH}}$`);

export const PairingCode = z
  .string()
  .transform(normalizePairingCode)
  .pipe(z.string().regex(codePattern, 'Invalid pairing code'));

/** What the pairing QR code carries. */
export const PairingPayload = z
  .object({
    version: z.literal(1),
    serverId: Id,
    serverName: z.string(),
    /** Address on the home network, e.g. `http://192.168.1.20:4810`. */
    homeUrl: BaseUrl.nullable(),
    /** Optional away-from-home HTTPS address (Tailscale or Cloudflare Tunnel). */
    remoteUrl: BaseUrl.nullable(),
    code: PairingCode,
    expiresAt: IsoDateTime,
  })
  .meta({ id: 'PairingPayload' });
export type PairingPayload = z.output<typeof PairingPayload>;

/**
 * Encodes the payload as `notgooglephotos://pair?v=1&id=…&name=…&home=…&remote=…&code=…&exp=…`
 * (`exp` in Unix seconds). Phones parse it with {@link parsePairingUri}.
 */
export function encodePairingUri(payload: PairingPayload): string {
  const params = new URLSearchParams();
  params.set('v', String(payload.version));
  params.set('id', payload.serverId);
  params.set('name', payload.serverName);
  if (payload.homeUrl) params.set('home', payload.homeUrl);
  if (payload.remoteUrl) params.set('remote', payload.remoteUrl);
  params.set('code', payload.code);
  params.set('exp', String(Math.floor(new Date(payload.expiresAt).getTime() / 1000)));
  return `${PAIRING_URI_SCHEME}://pair?${params.toString()}`;
}

/** Returns the payload, or `null` when the text is not a valid pairing URI. */
export function parsePairingUri(uri: string): PairingPayload | null {
  const prefix = `${PAIRING_URI_SCHEME}://pair?`;
  if (!uri.startsWith(prefix)) return null;
  const params = new URLSearchParams(uri.slice(prefix.length));
  const exp = Number(params.get('exp'));
  if (!Number.isFinite(exp) || exp <= 0) return null;
  const result = PairingPayload.safeParse({
    version: Number(params.get('v')),
    serverId: params.get('id'),
    serverName: params.get('name') ?? '',
    homeUrl: params.get('home'),
    remoteUrl: params.get('remote'),
    code: params.get('code') ?? '',
    expiresAt: new Date(exp * 1000).toISOString(),
  });
  return result.success ? result.data : null;
}
