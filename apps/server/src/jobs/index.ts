import { inArray } from 'drizzle-orm';
import { PgBoss } from 'pg-boss';
import type { AppContext } from '../context';
import { assets } from '../db/schema';
import { processAsset } from '../media/derivatives';
import { cleanupExpired, collectUnreferencedFiles } from './maintenance';

/**
 * Queue names. Each handler is idempotent so jobs can be retried and re-run.
 * Face grouping and search embeddings will add their own queues later.
 */
export const QUEUES = {
  cleanup: 'maintenance.cleanup',
  collectFiles: 'maintenance.collect-files',
  derivatives: 'asset.derivatives',
  derivativesSweep: 'asset.derivatives.sweep',
} as const;

export const JOBS_SCHEMA = 'pgboss';

export interface Jobs {
  boss: PgBoss;
  isRunning(): boolean;
  stop(): Promise<void>;
  /** Queue thumbnail and EXIF work for one asset. A second send while one is queued is a no-op. */
  enqueueAsset(assetId: string): Promise<void>;
}

/** Starts pg-boss (in the same Postgres, schema `pgboss`), its schedules, and the workers. */
export async function startJobs(ctx: AppContext): Promise<Jobs> {
  const log = ctx.log.child({ component: 'jobs' });
  const boss = new PgBoss({
    connectionString: ctx.env.DATABASE_URL,
    schema: JOBS_SCHEMA,
    application_name: 'ngp-jobs',
  });
  boss.on('error', (error) => log.error({ err: error }, 'Job queue error'));
  await boss.start();

  await boss.createQueue(QUEUES.cleanup, { retryLimit: 2, expireInSeconds: 600 });
  await boss.createQueue(QUEUES.collectFiles, { retryLimit: 2, expireInSeconds: 3600 });
  await boss.createQueue(QUEUES.derivatives, {
    retryLimit: 3,
    expireInSeconds: 600,
    retryDelay: 30,
  });
  await boss.createQueue(QUEUES.derivativesSweep, { retryLimit: 1, expireInSeconds: 600 });
  await boss.schedule(QUEUES.cleanup, '17 * * * *');
  await boss.schedule(QUEUES.collectFiles, '30 4 * * *');
  await boss.schedule(QUEUES.derivativesSweep, '*/10 * * * *');

  const enqueueAsset = async (assetId: string) => {
    await boss.send(QUEUES.derivatives, { assetId }, { singletonKey: assetId });
  };
  const enqueuePending = async () => {
    const pending = await ctx.db
      .select({ id: assets.id })
      .from(assets)
      .where(inArray(assets.processingState, ['pending', 'failed']))
      .limit(1000);
    for (const row of pending) await enqueueAsset(row.id);
    return pending.length;
  };

  await boss.work(QUEUES.cleanup, async () => {
    const result = await cleanupExpired(ctx.db);
    log.info(result, 'Removed expired sessions, pairing codes, and old trash');
  });
  await boss.work(QUEUES.collectFiles, async () => {
    const result = await collectUnreferencedFiles(ctx.files);
    log.info(result, 'Removed unreferenced files');
  });
  await boss.work<{ assetId: string }>(QUEUES.derivatives, async (jobs) => {
    for (const job of jobs) await processAsset(ctx, job.data.assetId);
  });
  await boss.work(QUEUES.derivativesSweep, async () => {
    const queued = await enqueuePending();
    if (queued > 0) log.info({ queued }, 'Queued photos that still need thumbnails');
  });

  const queued = await enqueuePending();
  if (queued > 0) log.info({ queued }, 'Queued photos that still need thumbnails');

  let running = true;
  return {
    boss,
    isRunning: () => running,
    enqueueAsset,
    stop: async () => {
      running = false;
      await boss.stop({ graceful: true, timeout: 10_000 });
    },
  };
}
