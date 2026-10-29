import { serve } from '@hono/node-server';
import { createApp } from './app';
import { createContext } from './context';
import { runMigrations } from './db/migrate';
import { loadDotEnv, parseEnv } from './env';
import { startJobs } from './jobs';
import { backfillPlaces } from './places/backfill';
import { createLogger } from './logger';
import { effectiveAddresses, getServerConfig } from './services/server-config';

loadDotEnv();
const env = parseEnv();
const log = createLogger(env);

await runMigrations(env.DATABASE_URL, log);
const ctx = await createContext(env, log);
if (env.JOBS_ENABLED) ctx.jobs = await startJobs(ctx);

const app = createApp(ctx);
const server = serve({ fetch: app.fetch, hostname: env.HOST, port: env.PORT }, (info) => {
  log.info(
    { address: info.address, port: info.port },
    `Not Google Photos ${ctx.version} is listening`,
  );
});

const config = await getServerConfig(ctx.db);
const addresses = effectiveAddresses(config, env);
log.info(
  { serverId: config.serverId, name: config.name, ...addresses, web: env.WEB_DIST_DIR ?? null },
  addresses.homeUrl ? `Phones on your network can use ${addresses.homeUrl}` : 'HOME_URL is not set',
);
const library = await ctx.library.status({ fresh: true });
if (library.state === 'ok') {
  log.info({ path: library.path, freeBytes: library.freeBytes }, 'Library folder ready');
} else {
  log.warn({ library }, `Uploads are paused: ${library.message}`);
}

void backfillPlaces(ctx.db)
  .then((filled) => {
    if (filled > 0) log.info({ filled }, 'Filled in place names');
  })
  .catch((error: unknown) => log.warn({ err: error }, 'Place names will retry'));

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  log.info({ signal }, 'Shutting down');
  const force = setTimeout(() => process.exit(1), 15_000);
  force.unref();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await ctx.jobs
    ?.stop()
    .catch((error: unknown) => log.error({ err: error }, 'Stopping jobs failed'));
  await ctx.pool.end();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
