import { PgBoss } from 'pg-boss';
import type { AppContext } from '../context';
import { cleanupExpired, collectUnreferencedFiles } from './maintenance';

/**
 * Queue names. Later pieces add theirs here (for example `asset.metadata`, `asset.thumbnails`,
 * `asset.faces`), each with an idempotent handler so jobs can be retried and re-run.
 */
export const QUEUES = {
  cleanup: 'maintenance.cleanup',
  collectFiles: 'maintenance.collect-files',
} as const;

export const JOBS_SCHEMA = 'pgboss';

export interface Jobs {
  boss: PgBoss;
  isRunning(): boolean;
  stop(): Promise<void>;
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
  await boss.schedule(QUEUES.cleanup, '17 * * * *');
  await boss.schedule(QUEUES.collectFiles, '30 4 * * *');

  await boss.work(QUEUES.cleanup, async () => {
    const result = await cleanupExpired(ctx.db);
    log.info(result, 'Removed expired sessions and pairing codes');
  });
  await boss.work(QUEUES.collectFiles, async () => {
    const result = await collectUnreferencedFiles(ctx.files);
    log.info(result, 'Removed unreferenced files');
  });

  let running = true;
  return {
    boss,
    isRunning: () => running,
    stop: async () => {
      running = false;
      await boss.stop({ graceful: true, timeout: 10_000 });
    },
  };
}
