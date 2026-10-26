import { describe, expect, it } from 'vitest';
import {
  AssetUploadFields,
  EmailInput,
  PairDeviceRequest,
  Sha1Hex,
  buildPath,
  endpointKeys,
  endpoints,
  type EndpointSpec,
} from '../src';
import { buildOpenApiDocument } from '../src/openapi';

const specs = Object.entries(endpoints) as [string, EndpointSpec][];

describe('contract', () => {
  it('has a unique method and path for every endpoint', () => {
    const seen = new Set<string>();
    for (const [, spec] of specs) {
      const route = `${spec.method} ${spec.path}`;
      expect(seen.has(route), route).toBe(false);
      seen.add(route);
    }
  });

  it('declares a params schema that matches the path segments', () => {
    for (const [key, spec] of specs) {
      const pathParams = [...spec.path.matchAll(/:([A-Za-z0-9_]+)/g)].map((m) => m[1]).sort();
      const schemaParams = Object.keys(spec.params?.shape ?? {}).sort();
      expect(schemaParams, key).toEqual(pathParams);
    }
  });

  it('gives every JSON endpoint a response schema', () => {
    for (const [key, spec] of specs) {
      const kind = spec.responseKind ?? 'json';
      if (kind === 'json') expect(spec.response, key).toBeDefined();
      else expect(spec.response, key).toBeUndefined();
      if (spec.successStatus === 204) expect(kind, key).toBe('empty');
    }
  });

  it('includes the A1 sync API as stable endpoints', () => {
    const sync = [
      ['POST', '/api/devices/pair'],
      ['POST', '/api/assets/check'],
      ['POST', '/api/assets'],
      ['POST', '/api/assets/verify'],
      ['GET', '/api/memories/upcoming'],
      ['GET', '/api/ping'],
    ];
    for (const [method, path] of sync) {
      const match = specs.find(([, spec]) => spec.method === method && spec.path === path);
      expect(match, `${method} ${path}`).toBeDefined();
      expect(match?.[1].stability).toBe('stable');
    }
  });

  it('fills path parameters', () => {
    expect(buildPath('/api/albums/:id/members/:userId', { id: 'a b', userId: 'c' })).toBe(
      '/api/albums/a%20b/members/c',
    );
    expect(() => buildPath('/api/devices/:id')).toThrow(/Missing path parameter/);
  });
});

describe('schemas', () => {
  it('normalizes checksums and emails', () => {
    expect(Sha1Hex.parse(' DA39A3EE5E6B4B0D3255BFEF95601890AFD80709 ')).toBe(
      'da39a3ee5e6b4b0d3255bfef95601890afd80709',
    );
    expect(Sha1Hex.safeParse('abc').success).toBe(false);
    expect(EmailInput.parse('  Dana@Example.COM ')).toBe('dana@example.com');
  });

  it('coerces multipart upload fields', () => {
    const fields = AssetUploadFields.parse({
      checksum: 'da39a3ee5e6b4b0d3255bfef95601890afd80709',
      filename: 'PXL_20261026_085200123.jpg',
      durationMs: '1500',
      isFavorite: 'true',
    });
    expect(fields.durationMs).toBe(1500);
    expect(fields.isFavorite).toBe(true);
  });

  it('accepts both pairing methods', () => {
    const device = { name: 'Pixel 8', platform: 'android' as const };
    expect(PairDeviceRequest.parse({ method: 'code', code: 'abcde-12345', device })).toMatchObject({
      code: 'ABCDE12345',
    });
    expect(
      PairDeviceRequest.safeParse({ method: 'password', email: 'a@b.co', password: 'x', device })
        .success,
    ).toBe(true);
    expect(PairDeviceRequest.safeParse({ method: 'code', code: 'short', device }).success).toBe(
      false,
    );
  });
});

describe('openapi', () => {
  it('documents every endpoint and marks unimplemented ones', () => {
    const implemented = new Set(['server.health']);
    const doc = buildOpenApiDocument({ version: '0.0.0-test', implemented }) as {
      openapi: string;
      paths: Record<string, Record<string, { operationId: string; 'x-implemented': boolean }>>;
      components: { schemas: Record<string, unknown> };
    };
    expect(doc.openapi).toBe('3.1.0');
    const operations = Object.values(doc.paths).flatMap((item) => Object.values(item));
    expect(operations.map((op) => op.operationId).sort()).toEqual([...endpointKeys].sort());
    expect(operations.find((op) => op.operationId === 'server.health')?.['x-implemented']).toBe(
      true,
    );
    expect(operations.find((op) => op.operationId === 'assets.check')?.['x-implemented']).toBe(
      false,
    );
    expect(doc.paths['/api/devices/{id}']).toBeDefined();
    expect(Object.keys(doc.components.schemas)).toEqual(
      expect.arrayContaining(['Device', 'AssetSummary', 'PairDeviceRequest', 'ApiError']),
    );
    expect(JSON.stringify(doc)).not.toContain('#/$defs/');
  });
});
