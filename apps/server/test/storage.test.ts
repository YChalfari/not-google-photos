import { createHash, randomBytes } from 'node:crypto';
import { readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assetFiles, assets, files } from '../src/db/schema';
import { blobKeyFor, LocalStorageProvider } from '../src/storage/local';
import {
  BlobNotFoundError,
  ChecksumMismatchError,
  PayloadTooLargeError,
} from '../src/storage/provider';
import { createUser, insertAsset, insertDerivedFile } from './support/factories';
import { createTestServer, type TestServer } from './support/server';

const sha1 = (bytes: Buffer) => createHash('sha1').update(bytes).digest('hex');
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

let t: TestServer;
let storage: LocalStorageProvider;

beforeAll(async () => {
  t = await createTestServer();
  storage = new LocalStorageProvider(t.libraryDir);
});
afterAll(() => t.close());

async function tmpLeftovers() {
  return readdir(path.join(t.libraryDir, 'tmp')).catch(() => []);
}

describe('LocalStorageProvider', () => {
  it('stores blobs by SHA-256 and returns both checksums', async () => {
    const bytes = randomBytes(10_000);
    const stored = await storage.put(bytes);
    expect(stored).toEqual({
      key: blobKeyFor(sha256(bytes)),
      sha256: sha256(bytes),
      sha1: sha1(bytes),
      size: bytes.length,
      deduplicated: false,
    });
    expect(stored.key).toMatch(/^blobs\/[0-9a-f]{2}\/[0-9a-f]{2}\/[0-9a-f]{64}$/);
    expect(await readFile(path.join(t.libraryDir, stored.key))).toEqual(bytes);
  });

  it('writes identical bytes once', async () => {
    const bytes = randomBytes(5000);
    const first = await storage.put(bytes);
    const second = await storage.put(Buffer.from(bytes));
    expect(second).toEqual({ ...first, deduplicated: true });
    expect(await tmpLeftovers()).toEqual([]);
  });

  it('streams from async iterables', async () => {
    const parts = [randomBytes(1000), randomBytes(2000), randomBytes(3000)];
    async function* source() {
      for (const part of parts) {
        await Promise.resolve();
        yield part;
      }
    }
    const stored = await storage.put(source());
    expect(stored.sha256).toBe(sha256(Buffer.concat(parts)));
  });

  it('rejects bytes that do not match the expected checksum, keeping nothing', async () => {
    const bytes = randomBytes(2000);
    await expect(
      storage.put(bytes, { expectedSha1: sha1(randomBytes(10)) }),
    ).rejects.toBeInstanceOf(ChecksumMismatchError);
    expect(await storage.stat(blobKeyFor(sha256(bytes)))).toBeNull();
    expect(await tmpLeftovers()).toEqual([]);
    await expect(storage.put(bytes, { expectedSha1: sha1(bytes) })).resolves.toMatchObject({
      size: 2000,
    });
  });

  it('stops reading at the size limit', async () => {
    await expect(storage.put(randomBytes(5000), { maxBytes: 4096 })).rejects.toBeInstanceOf(
      PayloadTooLargeError,
    );
    expect(await tmpLeftovers()).toEqual([]);
  });

  it('reads ranges, digests, and deletes', async () => {
    const bytes = randomBytes(1000);
    const { key } = await storage.put(bytes);
    const chunks: Buffer[] = [];
    for await (const chunk of await storage.open(key, { start: 100, end: 199 }))
      chunks.push(chunk as Buffer);
    expect(Buffer.concat(chunks)).toEqual(bytes.subarray(100, 200));
    expect(await storage.digest(key)).toEqual({
      sha1: sha1(bytes),
      sha256: sha256(bytes),
      size: 1000,
    });

    await storage.delete(key);
    expect(await storage.stat(key)).toBeNull();
    expect(await storage.digest(key)).toBeNull();
    await expect(storage.open(key)).rejects.toBeInstanceOf(BlobNotFoundError);
  });

  it('replaces a damaged copy with the wrong size', async () => {
    const bytes = randomBytes(1000);
    const { key } = await storage.put(bytes);
    await writeFile(path.join(t.libraryDir, key), bytes.subarray(0, 10));
    const again = await storage.put(bytes);
    expect(again.deduplicated).toBe(false);
    expect((await stat(path.join(t.libraryDir, key))).size).toBe(1000);
  });

  it('refuses keys outside the blob layout', async () => {
    await expect(storage.open('../../etc/passwd')).rejects.toThrow(/Invalid storage key/);
    await expect(storage.stat('blobs/zz/zz/nope')).rejects.toThrow(/Invalid storage key/);
  });
});

describe('FileStore and reference counts', () => {
  let ownerId: string;
  beforeAll(async () => {
    ownerId = (await createUser(t.ctx, { email: 'alex@example.com' })).id;
  });

  it('keeps one files row per unique blob', async () => {
    const bytes = randomBytes(3000);
    const first = await t.ctx.files.ingest(bytes, { mimeType: 'image/jpeg' });
    const second = await t.ctx.files.ingest(bytes);
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.file.id).toBe(first.file.id);
    expect(first.file).toMatchObject({
      sha1: sha1(bytes),
      sha256: sha256(bytes),
      sizeBytes: 3000,
      refCount: 0,
    });
  });

  it('counts references from assets and derived files, including cascades', async () => {
    const asset = await insertAsset(t.ctx, ownerId);
    const thumb = await insertDerivedFile(t.ctx, asset.id, 'thumbnail');
    const refCount = async (fileId: string) =>
      (
        await t.ctx.db.select({ refCount: files.refCount }).from(files).where(eq(files.id, fileId))
      )[0]?.refCount;
    expect(await refCount(asset.fileId)).toBe(1);
    expect(await refCount(thumb.fileId)).toBe(1);

    const other = await t.ctx.files.ingest(randomBytes(100));
    await t.ctx.db.update(assets).set({ fileId: other.file.id }).where(eq(assets.id, asset.id));
    expect(await refCount(asset.fileId)).toBe(0);
    expect(await refCount(other.file.id)).toBe(1);

    await t.ctx.db.delete(assets).where(eq(assets.id, asset.id));
    expect(await refCount(other.file.id)).toBe(0);
    expect(await refCount(thumb.fileId)).toBe(0);
    expect(
      await t.ctx.db.select().from(assetFiles).where(eq(assetFiles.assetId, asset.id)),
    ).toEqual([]);
  });

  it("won't delete a file row that's still referenced", async () => {
    const asset = await insertAsset(t.ctx, ownerId);
    await expect(t.ctx.db.delete(files).where(eq(files.id, asset.fileId))).rejects.toThrow();
  });

  it('verifies stored bytes and spots corruption and loss', async () => {
    const asset = await insertAsset(t.ctx, ownerId, { bytes: randomBytes(4000) });
    const file = (await t.ctx.files.get(asset.fileId))!;
    expect(await t.ctx.files.verify(file)).toBe('verified');
    const verified = (await t.ctx.files.get(asset.fileId))!;
    expect(verified.verifiedAt!.getTime()).toBeGreaterThanOrEqual(file.verifiedAt!.getTime());

    const blobPath = path.join(t.libraryDir, file.storageKey);
    await writeFile(blobPath, randomBytes(4000));
    expect(await t.ctx.files.verify(file)).toBe('mismatch');
    await rm(blobPath);
    expect(await t.ctx.files.verify(file)).toBe('missing');
  });

  it('collects unreferenced blobs after the grace period only', async () => {
    const orphan = await t.ctx.files.ingest(randomBytes(500));
    const kept = await insertAsset(t.ctx, ownerId);

    expect(await t.ctx.files.collectGarbage()).toBe(0);
    await t.ctx.db.update(files).set({ createdAt: new Date(Date.now() - 2 * 3600_000) });
    const removed = await t.ctx.files.collectGarbage();
    expect(removed).toBeGreaterThanOrEqual(1);

    expect(await t.ctx.files.get(orphan.file.id)).toBeUndefined();
    expect(await storage.stat(orphan.file.storageKey)).toBeNull();
    const keptFile = await t.ctx.files.get(kept.fileId);
    expect(keptFile).toBeDefined();
    expect(await storage.stat(keptFile!.storageKey)).not.toBeNull();
  });
});
