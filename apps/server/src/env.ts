import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BaseUrl } from '@ngp/shared';
import { z } from 'zod';

const here = path.dirname(fileURLToPath(import.meta.url));
/** `apps/server` in the repo, `/app` in the Docker image (this file is bundled into `dist/`). */
export const SERVER_ROOT = path.resolve(here, '..');
export const REPO_ROOT = path.resolve(SERVER_ROOT, '../..');
export const MIGRATIONS_DIR = path.join(SERVER_ROOT, 'drizzle');

const emptyToUndefined = (value: unknown) => (value === '' ? undefined : value);
const optional = <T extends z.ZodType>(schema: T) => z.preprocess(emptyToUndefined, schema.optional());
const withDefault = <T extends z.ZodType>(schema: T, fallback: z.output<T>) =>
  z.preprocess(emptyToUndefined, schema.default(fallback as never));

const EnvSchema = z.object({
  NODE_ENV: withDefault(z.enum(['development', 'test', 'production']), 'development'),
  HOST: withDefault(z.string(), '0.0.0.0'),
  PORT: withDefault(z.coerce.number().int().min(1).max(65535), 4810),
  DATABASE_URL: withDefault(z.string().min(1), 'postgres://ngp:ngp@localhost:54320/ngp'),
  /** Where originals, derived files, and database dumps live. Must already exist. */
  LIBRARY_DIR: optional(z.string().min(1)),
  /** Uploads are refused when the library drive has less free space than this. */
  LIBRARY_MIN_FREE_GB: withDefault(z.coerce.number().min(0), 2),
  /** Signs media URLs. Generated and stored in the database when not set. */
  SECRET_KEY: optional(z.string().min(32)),
  SERVER_NAME: optional(z.string().trim().min(1).max(80)),
  HOME_URL: optional(BaseUrl),
  REMOTE_URL: optional(BaseUrl),
  ML_URL: optional(BaseUrl),
  /** Built web app to serve at `/`. Defaults to `public/` next to the server when it exists. */
  WEB_DIST_DIR: optional(z.string().min(1)),
  JOBS_ENABLED: withDefault(z.stringbool(), true),
  /** Trust `X-Forwarded-*` headers (behind Cloudflare Tunnel, Tailscale Serve, or Caddy). */
  TRUST_PROXY: withDefault(z.stringbool(), false),
  /**
   * Extra browser origins allowed to call the API with a device token, comma-separated. The phone
   * app's origins are always allowed; cookies never work cross-origin.
   */
  CORS_ORIGINS: withDefault(
    z
      .string()
      .transform((value) =>
        value
          .split(',')
          .map((origin) => origin.trim().replace(/\/+$/, ''))
          .filter(Boolean),
      ),
    [],
  ),
  COOKIE_SECURE: withDefault(z.enum(['auto', 'always', 'never']), 'auto'),
  SESSION_TTL_DAYS: withDefault(z.coerce.number().int().min(1).max(365), 30),
  MEDIA_URL_TTL_SECONDS: withDefault(
    z.coerce
      .number()
      .int()
      .min(60)
      .max(7 * 86_400),
    7200,
  ),
  LOG_LEVEL: withDefault(z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']), 'info'),
});

export type Env = Omit<z.output<typeof EnvSchema>, 'LIBRARY_DIR' | 'WEB_DIST_DIR'> & {
  LIBRARY_DIR: string;
  WEB_DIST_DIR: string | undefined;
};

/** Loads the repo-root `.env` during development. Real environment variables win. */
export function loadDotEnv(): void {
  if (process.env.NODE_ENV === 'production' || process.env.NODE_ENV === 'test') return;
  const file = path.join(REPO_ROOT, '.env');
  if (existsSync(file)) process.loadEnvFile(file);
}

export function parseEnv(source: Record<string, string | undefined> = process.env): Env {
  const result = EnvSchema.safeParse(source);
  if (!result.success) {
    const problems = result.error.issues
      .map((issue) => `  ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${problems}`);
  }
  const env = result.data;
  let libraryDir = env.LIBRARY_DIR;
  if (!libraryDir) {
    if (env.NODE_ENV === 'production') {
      throw new Error('LIBRARY_DIR must be set in production (the Docker image sets /library).');
    }
    libraryDir = path.join(REPO_ROOT, 'data', 'library');
  }
  const bundledWeb = path.join(SERVER_ROOT, 'public');
  return {
    ...env,
    LIBRARY_DIR: path.resolve(libraryDir),
    WEB_DIST_DIR: env.WEB_DIST_DIR ?? (existsSync(bundledWeb) ? bundledWeb : undefined),
  };
}
