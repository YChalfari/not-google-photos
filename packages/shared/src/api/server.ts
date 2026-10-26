import { z } from 'zod';
import { defineEndpoints } from '../contract/define';
import { BaseUrl, Bytes, Id, IsoDateTime } from '../primitives';

export const LIBRARY_STATES = [
  'ok',
  'missing',
  'mismatch',
  'not_writable',
  'low_space',
  'uninitialized',
] as const;
export const LibraryState = z.enum(LIBRARY_STATES).meta({
  description:
    '`ok`: uploads accepted. `missing`: the library folder or its marker file is gone (drive unplugged). ' +
    '`mismatch`: the folder belongs to another server. `not_writable`, `low_space`: self-explanatory. ' +
    '`uninitialized`: no marker yet and the folder is not usable.',
});
export type LibraryState = z.infer<typeof LibraryState>;

export const HealthResponse = z
  .object({
    status: z.enum(['ok', 'degraded', 'down']),
    version: z.string(),
    uptimeSeconds: z.number().int().nonnegative(),
    checks: z.object({
      database: z.enum(['ok', 'error']),
      library: LibraryState,
      ml: z.enum(['ok', 'unreachable', 'disabled']),
      jobs: z.enum(['running', 'stopped', 'disabled']),
    }),
  })
  .meta({ id: 'Health' });

export const PingResponse = z
  .object({
    ok: z.literal(true),
    serverId: Id,
    time: IsoDateTime,
  })
  .meta({ id: 'Ping' });

export const ServerInfo = z
  .object({
    serverId: Id,
    name: z.string(),
    version: z.string(),
    apiVersion: z.number().int(),
    setupRequired: z.boolean(),
    homeUrl: BaseUrl.nullable(),
    remoteUrl: BaseUrl.nullable(),
  })
  .meta({ id: 'ServerInfo' });
export type ServerInfo = z.infer<typeof ServerInfo>;

export const LibraryStatus = z
  .object({
    state: LibraryState,
    path: z.string(),
    freeBytes: Bytes.nullable(),
    totalBytes: Bytes.nullable(),
    message: z.string(),
  })
  .meta({ id: 'LibraryStatus' });
export type LibraryStatus = z.infer<typeof LibraryStatus>;

export const serverEndpoints = defineEndpoints({
  'server.health': {
    method: 'GET',
    path: '/api/health',
    auth: 'public',
    tag: 'server',
    summary: 'Health of the server, database, library folder, ML service, and job queue',
    description: 'Returns 200 unless the database is down (then 503).',
    response: HealthResponse,
    stability: 'stable',
  },
  'server.ping': {
    method: 'GET',
    path: '/api/ping',
    auth: 'public',
    tag: 'server',
    summary: 'Cheap reachability check',
    description:
      'Phones call this first on every sync run, with a short timeout, before scanning or hashing. ' +
      'Compare `serverId` with the paired server to make sure the address still points at it.',
    response: PingResponse,
    stability: 'stable',
  },
  'server.info': {
    method: 'GET',
    path: '/api/server/info',
    auth: 'public',
    tag: 'server',
    summary: 'Public server identity, addresses, and whether first-run setup is needed',
    response: ServerInfo,
    stability: 'stable',
  },
});
