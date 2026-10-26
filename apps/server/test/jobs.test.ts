import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashToken } from '../src/auth/tokens';
import { files, pairingCodes, sessions } from '../src/db/schema';
import { cleanupExpired, collectUnreferencedFiles } from '../src/jobs/maintenance';
import { createUser, insertAsset } from './support/factories';
import { createTestServer, type TestServer } from './support/server';

const DAY_MS = 86_400_000;

let t: TestServer;

beforeAll(async () => {
  t = await createTestServer();
});
afterAll(() => t.close());

describe('maintenance jobs', () => {
  it('deletes expired sessions and pairing codes, and keeps live ones', async () => {
    const user = await createUser(t.ctx, { email: 'alex@example.com', role: 'admin' });
    const now = new Date('2026-10-26T12:00:00Z');
    await t.ctx.db.insert(sessions).values([
      {
        userId: user.id,
        tokenHash: hashToken('ngps_expired'),
        expiresAt: new Date(now.getTime() - DAY_MS),
      },
      {
        userId: user.id,
        tokenHash: hashToken('ngps_live'),
        expiresAt: new Date(now.getTime() + DAY_MS),
      },
    ]);
    await t.ctx.db.insert(pairingCodes).values([
      {
        userId: user.id,
        codeHash: hashToken('expired-code'),
        expiresAt: new Date(now.getTime() - 2 * DAY_MS),
      },
      {
        userId: user.id,
        codeHash: hashToken('used-code'),
        expiresAt: new Date(now.getTime() + DAY_MS),
        usedAt: new Date(now.getTime() - 2 * DAY_MS),
      },
      {
        userId: user.id,
        codeHash: hashToken('pending-code'),
        expiresAt: new Date(now.getTime() + 5 * 60_000),
      },
    ]);

    const result = await cleanupExpired(t.ctx.db, now);
    expect(result).toEqual({ sessions: 1, pairingCodes: 2 });

    const leftSessions = await t.ctx.db.select().from(sessions);
    expect(leftSessions.map((row) => row.tokenHash)).toEqual([hashToken('ngps_live')]);
    const leftCodes = await t.ctx.db.select().from(pairingCodes);
    expect(leftCodes.map((row) => row.codeHash)).toEqual([hashToken('pending-code')]);
  });

  it('removes unreferenced blobs past the grace period and keeps the rest', async () => {
    const user = await createUser(t.ctx, { email: 'sam@example.com' });
    const kept = await insertAsset(t.ctx, user.id, { bytes: randomBytes(128) });
    const { file: orphan } = await t.ctx.files.ingest(randomBytes(64), { mimeType: 'image/jpeg' });
    const { file: fresh } = await t.ctx.files.ingest(randomBytes(32), { mimeType: 'image/jpeg' });
    const old = new Date(Date.now() - 3 * 60 * 60 * 1000);
    await t.ctx.db.update(files).set({ createdAt: old }).where(eq(files.id, orphan.id));
    await t.ctx.db.update(files).set({ createdAt: old }).where(eq(files.id, kept.fileId));

    const result = await collectUnreferencedFiles(t.ctx.files);
    expect(result.removed).toBe(1);

    const remaining = await t.ctx.db.select({ id: files.id }).from(files);
    expect(remaining.map((row) => row.id).sort()).toEqual([fresh.id, kept.fileId].sort());
    expect(await t.ctx.files.storage.stat(orphan.storageKey)).toBeNull();
    const keptFile = await t.ctx.files.get(kept.fileId);
    expect(await t.ctx.files.storage.stat(keptFile!.storageKey)).not.toBeNull();
  });
});
