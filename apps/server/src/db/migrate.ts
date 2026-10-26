import { setTimeout as sleep } from 'node:timers/promises';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { MIGRATIONS_DIR } from '../env';
import type { Logger } from '../logger';

/** Waits for Postgres (it may still be starting under Docker), then applies pending migrations. */
export async function runMigrations(
  connectionString: string,
  log?: Logger,
  options: { waitSeconds?: number } = {},
): Promise<void> {
  const deadline = Date.now() + (options.waitSeconds ?? 60) * 1000;
  let client: pg.Client;
  for (;;) {
    client = new pg.Client({ connectionString, application_name: 'ngp-migrate' });
    try {
      await client.connect();
      break;
    } catch (error) {
      await client.end().catch(() => undefined);
      if (Date.now() > deadline) throw error;
      log?.info('Waiting for the database...');
      await sleep(2000);
    }
  }
  try {
    await migrate(drizzle(client), { migrationsFolder: MIGRATIONS_DIR });
    log?.info('Database migrations are up to date');
  } finally {
    await client.end();
  }
}
