import { runMigrations } from '../db/migrate';
import { loadDotEnv, parseEnv } from '../env';
import { createLogger } from '../logger';

loadDotEnv();
const env = parseEnv();
const log = createLogger(env);

try {
  await runMigrations(env.DATABASE_URL, log);
} catch (error) {
  log.error({ err: error }, 'Migration failed');
  process.exitCode = 1;
}
