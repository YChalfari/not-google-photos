import { eq, isNull } from 'drizzle-orm';
import type pg from 'pg';
import { createDatabase, type Db } from './db/client';
import { serverConfig } from './db/schema';
import type { Env } from './env';
import { createRateLimits, type RateLimits } from './http/rate-limit';
import type { Jobs } from './jobs';
import type { Logger } from './logger';
import { MediaSigner } from './media/signer';
import { MlClient } from './ml/client';
import { ensureServerConfig, getServerConfig } from './services/server-config';
import { FileStore } from './storage/file-store';
import { LibraryGuard } from './storage/library-guard';
import { LocalStorageProvider } from './storage/local';
import type { StorageProvider } from './storage/provider';
import { VERSION } from './version';

/** Everything a request handler or job needs. Built once per process (and once per test file). */
export interface AppContext {
  env: Env;
  log: Logger;
  db: Db;
  pool: pg.Pool;
  version: string;
  startedAt: Date;
  serverId: string;
  library: LibraryGuard;
  storage: StorageProvider;
  files: FileStore;
  media: MediaSigner;
  ml: MlClient;
  limits: RateLimits;
  /** Set once the job queue has started; `null` when JOBS_ENABLED=false. */
  jobs: Jobs | null;
}

export async function createContext(env: Env, log: Logger): Promise<AppContext> {
  const { db, pool } = createDatabase(env.DATABASE_URL);
  const config = await ensureServerConfig(db, env);

  const library = new LibraryGuard({
    dir: env.LIBRARY_DIR,
    serverId: config.serverId,
    minFreeBytes: env.LIBRARY_MIN_FREE_GB * 1024 ** 3,
    isInitialized: async () => (await getServerConfig(db)).libraryInitializedAt !== null,
    markInitialized: async () => {
      await db
        .update(serverConfig)
        .set({ libraryInitializedAt: new Date() })
        .where(eq(serverConfig.id, 1))
        .where(isNull(serverConfig.libraryInitializedAt));
    },
  });
  const storage = new LocalStorageProvider(env.LIBRARY_DIR, library);

  return {
    env,
    log,
    db,
    pool,
    version: VERSION,
    startedAt: new Date(),
    serverId: config.serverId,
    library,
    storage,
    files: new FileStore(db, storage),
    media: new MediaSigner(env.SECRET_KEY ?? config.signingSecret, env.MEDIA_URL_TTL_SECONDS),
    ml: new MlClient(env.ML_URL),
    limits: createRateLimits(),
    jobs: null,
  };
}
