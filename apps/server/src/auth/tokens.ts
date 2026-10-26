import { createHash, randomBytes, randomInt } from 'node:crypto';
import { PAIRING_CODE_ALPHABET, PAIRING_CODE_LENGTH } from '@ngp/shared';

/** 256-bit random token with a recognizable prefix, e.g. `ngpd_…`. */
export function generateToken(prefix: string): string {
  return `${prefix}${randomBytes(32).toString('base64url')}`;
}

/** Tokens are stored only as SHA-256 hashes. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** 10 Crockford base32 characters (50 bits); single-use, short-lived, and rate limited. */
export function generatePairingCode(): string {
  let code = '';
  for (let i = 0; i < PAIRING_CODE_LENGTH; i += 1) {
    code += PAIRING_CODE_ALPHABET[randomInt(PAIRING_CODE_ALPHABET.length)];
  }
  return code;
}
