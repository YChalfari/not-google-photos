import { API_VERSION } from '@ngp/shared';
import type { Handlers } from '../http/contract';
import { countUsers } from '../services/accounts';
import { effectiveAddresses, getServerConfig } from '../services/server-config';

export const serverHandlers: Handlers = {
  'server.health': async ({ ctx, setStatus }) => {
    const [database, library, ml] = await Promise.all([
      ctx.pool.query('select 1').then(
        () => 'ok' as const,
        () => 'error' as const,
      ),
      ctx.library.status().then(
        (status) => status.state,
        () => 'uninitialized' as const,
      ),
      ctx.ml.status(),
    ]);
    const jobs = !ctx.env.JOBS_ENABLED ? 'disabled' : ctx.jobs?.isRunning() ? 'running' : 'stopped';
    const status =
      database === 'error'
        ? 'down'
        : library !== 'ok' || jobs === 'stopped' || ml === 'unreachable'
          ? 'degraded'
          : 'ok';
    if (status === 'down') setStatus(503);
    return {
      status,
      version: ctx.version,
      uptimeSeconds: Math.floor((Date.now() - ctx.startedAt.getTime()) / 1000),
      checks: { database, library, ml, jobs },
    };
  },

  'server.ping': ({ ctx }) => ({
    ok: true,
    serverId: ctx.serverId,
    time: new Date().toISOString(),
  }),

  'server.info': async ({ ctx }) => {
    const [config, userCount] = await Promise.all([getServerConfig(ctx.db), countUsers(ctx.db)]);
    return {
      serverId: config.serverId,
      name: config.name,
      version: ctx.version,
      apiVersion: API_VERSION,
      setupRequired: userCount === 0,
      ...effectiveAddresses(config, ctx.env),
    };
  },
};
