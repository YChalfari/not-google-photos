import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Hono } from 'hono';
import { createApp } from '../../src/app';
import { createContext, type AppContext } from '../../src/context';
import { parseEnv } from '../../src/env';
import type { AppEnv } from '../../src/http/types';
import { createRateLimits, type RateLimits } from '../../src/http/rate-limit';
import { createLogger } from '../../src/logger';
import { createTestDatabase, databaseUrl, dropTestDatabase } from './db';

export interface TestServer {
  ctx: AppContext;
  app: Hono<AppEnv>;
  libraryDir: string;
  databaseName: string;
  databaseUrl: string;
  close(): Promise<void>;
}

export interface TestServerOptions {
  env?: Record<string, string>;
  limits?: RateLimits;
  /** Use an existing folder as the library instead of a fresh temp folder. */
  libraryDir?: string;
}

/** A server with its own database and library folder, called in-process with `app.request`. */
export async function createTestServer(options: TestServerOptions = {}): Promise<TestServer> {
  const databaseName = await createTestDatabase();
  const libraryDir = options.libraryDir ?? (await mkdtemp(path.join(os.tmpdir(), 'ngp-library-')));
  const url = databaseUrl(databaseName);
  const env = parseEnv({
    NODE_ENV: 'test',
    DATABASE_URL: url,
    LIBRARY_DIR: libraryDir,
    LIBRARY_MIN_FREE_GB: '0',
    JOBS_ENABLED: 'false',
    LOG_LEVEL: process.env.TEST_LOG_LEVEL ?? 'silent',
    SECRET_KEY: 'test-secret-key-that-is-at-least-32-characters',
    ...options.env,
  });
  const ctx = await createContext(env, createLogger(env), {
    limits: options.limits ?? createRateLimits({ ip: 100_000, invites: 100_000, pairing: 100_000 }),
  });
  const app = createApp(ctx);
  return {
    ctx,
    app,
    libraryDir,
    databaseName,
    databaseUrl: url,
    async close() {
      await ctx.jobs?.stop();
      await ctx.pool.end();
      await dropTestDatabase(databaseName);
      if (!options.libraryDir) await rm(libraryDir, { recursive: true, force: true });
    },
  };
}
