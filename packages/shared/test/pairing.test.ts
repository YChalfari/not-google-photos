import { describe, expect, it } from 'vitest';
import {
  BonjourTxtRecord,
  encodePairingUri,
  formatPairingCode,
  normalizePairingCode,
  parsePairingUri,
  type PairingPayload,
} from '../src';

const payload: PairingPayload = {
  version: 1,
  serverId: '2b0f8f0e-5f6b-4b8e-9a43-0c2b7f6d1e11',
  serverName: 'Levi Family Photos',
  homeUrl: 'http://192.168.1.20:4810',
  remoteUrl: 'https://photos.example.com',
  code: 'ABCDE12345',
  expiresAt: '2026-10-26T09:10:00.000Z',
};

describe('pairing URI', () => {
  it('round-trips the payload', () => {
    const uri = encodePairingUri(payload);
    expect(uri.startsWith('notgooglephotos://pair?')).toBe(true);
    expect(parsePairingUri(uri)).toEqual(payload);
  });

  it('omits the remote address when there is none', () => {
    const uri = encodePairingUri({ ...payload, remoteUrl: null });
    expect(uri).not.toContain('remote=');
    expect(parsePairingUri(uri)?.remoteUrl).toBeNull();
  });

  it('rejects other QR codes', () => {
    expect(parsePairingUri('https://example.com')).toBeNull();
    expect(parsePairingUri('notgooglephotos://pair?v=1&id=nope&code=ABCDE12345&exp=1')).toBeNull();
    expect(parsePairingUri(encodePairingUri(payload).replace('code=ABCDE12345', 'code=!!'))).toBeNull();
  });

  it('normalizes typed codes', () => {
    expect(normalizePairingCode('abcde-1234o')).toBe('ABCDE12340');
    expect(normalizePairingCode('ilxyz 98765')).toBe('11XYZ98765');
    expect(formatPairingCode('ABCDE12345')).toBe('ABCDE-12345');
  });
});

describe('Bonjour TXT record', () => {
  it('parses the announced fields', () => {
    expect(BonjourTxtRecord.parse({ id: payload.serverId, name: 'Photos', v: '1' })).toEqual({
      id: payload.serverId,
      name: 'Photos',
      v: 1,
      api: '/api',
    });
  });
});
