import { runMigrations } from '../../src/db/migrate';
import { TEMPLATE_DB, TEST_DB_PREFIX, databaseUrl, withAdmin } from './db';

/** Builds the migrated template database once per run; test files clone it. */
export default async function setup() {
  await withAdmin(async (client) => {
    const { rows } = await client.query<{ datname: string }>(
      `select datname from pg_database where datname like $1`,
      [`${TEST_DB_PREFIX}%`],
    );
    for (const { datname } of rows)
      await client.query(`drop database if exists ${datname} with (force)`);
    await client.query(`create database ${TEMPLATE_DB}`);
  });
  await runMigrations(databaseUrl(TEMPLATE_DB), undefined, { waitSeconds: 30 });

  return async () => {
    await withAdmin((client) =>
      client.query(`drop database if exists ${TEMPLATE_DB} with (force)`),
    );
  };
}
