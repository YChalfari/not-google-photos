import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { Db, DbOrTx } from '../db/client';
import { serverConfig, type ServerConfigRow } from '../db/schema';
import type { Env } from '../env';

export async function ensureServerConfig(db: Db, env: Env): Promise<ServerConfigRow> {
  await db
    .insert(serverConfig)
    .values({
      id: 1,
      name: env.SERVER_NAME ?? 'Not Google Photos',
      signingSecret: randomBytes(32).toString('base64url'),
    })
    .onConflictDoNothing();
  return getServerConfig(db);
}

export async function getServerConfig(db: DbOrTx): Promise<ServerConfigRow> {
  const [row] = await db.select().from(serverConfig).where(eq(serverConfig.id, 1));
  if (!row) throw new Error('server_config row is missing; was ensureServerConfig() called?');
  return row;
}

export interface ServerAddresses {
  homeUrl: string | null;
  remoteUrl: string | null;
}

/** Addresses set by the admin win over the environment defaults. */
export function effectiveAddresses(config: ServerConfigRow, env: Env): ServerAddresses {
  return {
    homeUrl: config.homeUrl ?? env.HOME_URL ?? null,
    remoteUrl: config.remoteUrl ?? env.REMOTE_URL ?? null,
  };
}
