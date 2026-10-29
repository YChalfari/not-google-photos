import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { files } from '../src/db/schema';
import { verifyStoredFiles } from '../src/jobs/verify-files';
import { createUser, insertAsset, signIn } from './support/factories';
import { createTestServer, type TestServer } from './support/server';

let t: TestServer;

beforeAll(async () => {
  t = await createTestServer();
});
afterAll(() => t.close());

describe('nightly file check', () => {
  it('records a mismatch, leaves the file in place, and clears it when the bytes match again', async () => {
    const admin = await createUser(t.ctx, { email: 'verify@example.com', role: 'admin' });
    const bytes = randomBytes(4000);
    const asset = await insertAsset(t.ctx, admin.id, { bytes });
    const file = (await t.ctx.files.get(asset.fileId))!;
    const blobPath = path.join(t.libraryDir, file.storageKey);
    const original = await readFile(blobPath);
    await writeFile(blobPath, randomBytes(4000));

    const bad = await verifyStoredFiles(t.ctx);
    expect(bad.mismatch).toBe(1);
    expect(await t.ctx.files.storage.stat(file.storageKey)).not.toBeNull();
    const marked = (await t.ctx.files.get(file.id))!;
    expect(marked.verifyProblem).toBe('mismatch');

    const browser = await signIn(t.app, admin.email);
    const settings = await browser.call('admin.server.get');
    expect(settings.status).toBe(200);
    expect(settings.data.files.problemCount).toBe(1);
    expect(settings.data.files.problems).toEqual([{ id: file.id, problem: 'mismatch' }]);

    await writeFile(blobPath, original);
    await t.ctx.db
      .update(files)
      .set({ verifiedAt: new Date(0) })
      .where(eq(files.id, file.id));
    const good = await verifyStoredFiles(t.ctx);
    expect(good.verified).toBeGreaterThan(0);
    expect(good.mismatch).toBe(0);
    const cleared = (await t.ctx.files.get(file.id))!;
    expect(cleared.verifyProblem).toBeNull();
    expect(await t.ctx.files.storage.stat(file.storageKey)).not.toBeNull();
    expect(await readFile(blobPath)).toEqual(original);
  });
});
