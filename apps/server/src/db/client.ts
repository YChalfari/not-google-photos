import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema';

export type Db = NodePgDatabase<typeof schema>;
/** A transaction handle; accepted wherever a `Db` is. */
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
export type DbOrTx = Db | Tx;

export interface Database {
  db: Db;
  pool: pg.Pool;
}

export function createDatabase(connectionString: string, options: { max?: number } = {}): Database {
  const pool = new pg.Pool({
    connectionString,
    max: options.max ?? 10,
    application_name: 'ngp-server',
  });
  const db = drizzle(pool, { schema });
  return { db, pool };
}

export { schema };
