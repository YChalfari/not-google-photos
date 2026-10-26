import { randomBytes } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import pg from 'pg';

/** Postgres the tests run against (the `db:up` container by default). Needs CREATE DATABASE. */
export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://ngp:ngp@localhost:54320/ngp';

export const TEMPLATE_DB = 'ngp_test_template';
export const TEST_DB_PREFIX = 'ngp_test_';

export function databaseUrl(name: string): string {
  const url = new URL(TEST_DATABASE_URL);
  url.pathname = `/${name}`;
  return url.toString();
}

export async function withAdmin<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({
    connectionString: databaseUrl('postgres'),
    application_name: 'ngp-test-admin',
  });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/** A fresh, fully migrated database for one test file. */
export async function createTestDatabase(): Promise<string> {
  const name = `${TEST_DB_PREFIX}${randomBytes(6).toString('hex')}`;
  await withAdmin(async (client) => {
    for (let attempt = 0; ; attempt += 1) {
      try {
        await client.query(`create database ${name} template ${TEMPLATE_DB}`);
        return;
      } catch (error) {
        // Another file is cloning the template at the same moment.
        if (attempt > 20 || !String(error).includes('being accessed by other users')) throw error;
        await sleep(100 + Math.random() * 200);
      }
    }
  });
  return name;
}

export async function dropTestDatabase(name: string): Promise<void> {
  await withAdmin((client) => client.query(`drop database if exists ${name} with (force)`));
}
