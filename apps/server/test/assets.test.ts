import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SAMPLE_SHOTS, renderSamplePhoto } from '../src/cli/sample-photos';
import { assets, files } from '../src/db/schema';
import { createUser, pairPhone, signIn } from './support/factories';
import { createTestServer, type TestServer } from './support/server';

let t: TestServer;

beforeAll(async () => {
  t = await createTestServer();
});
afterAll(() => t.close());

function sha1(bytes: Buffer): string {
  return createHash('sha1').update(bytes).digest('hex');
}

function multipart(
  fields: Record<string, string>,
  file: { name: string; type: string; bytes: Buffer },
) {
  const boundary = 'ngp-test-boundary';
  const parts = Object.entries(fields).map(([name, value]) =>
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
    ),
  );
  return {
    contentType: `multipart/form-data; boundary=${boundary}`,
    body: Buffer.concat([
      ...parts,
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: ${file.type}\r\n\r\n`,
      ),
      file.bytes,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
  };
}

async function jpeg(color: { r: number; g: number; b: number }) {
  return sharp({
    create: { width: 16, height: 12, channels: 3, background: color },
  })
    .jpeg()
    .toBuffer();
}

describe('asset upload, thumbnails, and verify', () => {
  it('stores a photo once per account, builds a thumbnail, and verifies the bytes', async () => {
    const alex = await createUser(t.ctx, { email: 'alex@example.com' });
    const sam = await createUser(t.ctx, { email: 'sam@example.com' });
    const alexBrowser = await signIn(t.app, alex.email);
    const samBrowser = await signIn(t.app, sam.email);
    const { phone } = await pairPhone(alexBrowser);

    const bytes = await jpeg({ r: 20, g: 80, b: 160 });
    const checksum = sha1(bytes);
    const form = multipart(
      {
        checksum,
        filename: 'PXL_20240615_010000.jpg',
        capturedAt: '2024-06-15T01:00:00+03:00',
        favorite: 'true',
        deviceAssetId: 'media:7',
      },
      { name: 'PXL_20240615_010000.jpg', type: 'image/jpeg', bytes },
    );

    const missing = await phone.call('assets.check', {
      body: { checksums: [checksum, 'ab'.repeat(20)] },
    });
    expect(missing.status).toBe(200);
    expect(missing.data.missing).toEqual([checksum, 'ab'.repeat(20)]);
    expect(missing.data.present).toEqual([]);

    const created = await phone.fetch('/api/assets', {
      method: 'POST',
      headers: { 'content-type': form.contentType },
      body: form.body,
    });
    expect(created.status, await created.clone().text()).toBe(201);
    const uploaded = (await created.json()) as { assetId: string; status: string };
    expect(uploaded.status).toBe('created');

    const again = await phone.fetch('/api/assets', {
      method: 'POST',
      headers: { 'content-type': form.contentType },
      body: form.body,
    });
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ assetId: uploaded.assetId, status: 'duplicate' });

    const present = await phone.call('assets.check', { body: { checksums: [checksum] } });
    expect(present.data.present).toEqual([{ checksum, assetId: uploaded.assetId }]);
    const samMissing = await samBrowser.call('assets.check', { body: { checksums: [checksum] } });
    expect(samMissing.data.missing).toEqual([checksum]);

    const [row] = await t.ctx.db.select().from(assets).where(eq(assets.id, uploaded.assetId));
    expect(row).toMatchObject({
      isFavorite: true,
      localDate: '2024-06-15',
      timezone: '+03:00',
      deviceAssetId: 'media:7',
      width: 16,
      height: 12,
      processingState: 'ready',
    });
    expect(row?.thumbhash).toEqual(expect.any(String));
    const [blob] = await t.ctx.db.select().from(files).where(eq(files.id, row!.fileId));
    expect(blob?.refCount).toBe(1);

    const month = await alexBrowser.call('timeline.bucket', {
      params: { key: '2024-06' },
      query: { scope: 'library', withShared: 'true' },
    });
    expect(month.status).toBe(200);
    expect(month.data.assets.map((asset) => asset.id)).toEqual([uploaded.assetId]);
    const thumbnail = month.data.assets[0]?.thumbnailUrl;
    expect(thumbnail).toMatch(/^\/api\/media\//);
    const image = await alexBrowser.fetch(thumbnail!);
    expect(image.status).toBe(200);
    expect(image.headers.get('content-type')).toContain('image/webp');

    const detail = await alexBrowser.call('assets.get', { params: { id: uploaded.assetId } });
    expect(detail.status).toBe(200);
    expect(detail.data).toMatchObject({
      originalFilename: 'PXL_20240615_010000.jpg',
      isFavorite: true,
      localDate: '2024-06-15',
      sizeBytes: bytes.length,
    });
    expect(detail.data.originalUrl).toMatch(/^\/api\/media\//);

    const hidden = await samBrowser.call('assets.get', { params: { id: uploaded.assetId } });
    expect(hidden.status).toBe(404);

    const verified = await phone.call('assets.verify', {
      body: {
        items: [
          { checksum, size: bytes.length },
          { checksum: 'cd'.repeat(20), size: 1 },
        ],
      },
    });
    expect(verified.data.results).toEqual([
      { checksum, assetId: uploaded.assetId, status: 'verified' },
      { checksum: 'cd'.repeat(20), assetId: null, status: 'missing' },
    ]);
    const mismatch = await phone.call('assets.verify', {
      body: { items: [{ checksum, size: bytes.length + 1 }] },
    });
    expect(mismatch.data.results[0]?.status).toBe('mismatch');
  });

  it('prefers EXIF over the capture time the client sent', async () => {
    const user = await createUser(t.ctx, { email: 'exif@example.com' });
    const browser = await signIn(t.app, user.email);
    const shot = SAMPLE_SHOTS.find((item) => item.place);
    if (!shot?.place) throw new Error('expected a sample photo with a place');
    const photo = await renderSamplePhoto(shot);
    const checksum = sha1(photo.bytes);
    const form = multipart(
      { checksum, filename: shot.filename, capturedAt: '2020-01-01T00:00:00.000Z' },
      { name: shot.filename, type: 'image/jpeg', bytes: photo.bytes },
    );
    const created = await browser.fetch('/api/assets', {
      method: 'POST',
      headers: { 'content-type': form.contentType },
      body: form.body,
    });
    expect(created.status, await created.clone().text()).toBe(201);
    const { assetId } = (await created.json()) as { assetId: string };
    const detail = await browser.call('assets.get', { params: { id: assetId } });
    expect(detail.data.localDate).toBe(photo.localDate);
    expect(detail.data.camera).toMatchObject({ make: 'NGP', model: 'Seed' });
    expect(detail.data.location?.latitude).toBeCloseTo(shot.place.latitude, 1);
    expect(detail.data.location?.longitude).toBeCloseTo(shot.place.longitude, 1);
  });

  it('rejects a bad checksum, an unsupported type, and a quota overrun', async () => {
    const user = await createUser(t.ctx, { email: 'limited@example.com', quotaBytes: 1 });
    const browser = await signIn(t.app, user.email);
    const bytes = await jpeg({ r: 1, g: 2, b: 3 });

    const bad = multipart(
      { checksum: 'a'.repeat(40), filename: 'photo.jpg' },
      { name: 'photo.jpg', type: 'image/jpeg', bytes },
    );
    const mismatch = await browser.fetch('/api/assets', {
      method: 'POST',
      headers: { 'content-type': bad.contentType },
      body: bad.body,
    });
    expect(mismatch.status).toBe(422);

    const text = multipart(
      { checksum: sha1(Buffer.from('hello')), filename: 'notes.txt' },
      { name: 'notes.txt', type: 'text/plain', bytes: Buffer.from('hello') },
    );
    const unsupported = await browser.fetch('/api/assets', {
      method: 'POST',
      headers: { 'content-type': text.contentType },
      body: text.body,
    });
    expect(unsupported.status).toBe(415);

    const over = multipart(
      { checksum: sha1(bytes), filename: 'big.jpg' },
      { name: 'big.jpg', type: 'image/jpeg', bytes },
    );
    const quota = await browser.fetch('/api/assets', {
      method: 'POST',
      headers: { 'content-type': over.contentType },
      body: over.body,
    });
    expect(quota.status).toBe(507);
    const left = await t.ctx.db
      .select({ id: assets.id })
      .from(assets)
      .where(eq(assets.ownerId, user.id));
    expect(left).toEqual([]);
  });

  it('favorites and trashes only the assets you own', async () => {
    const owner = await createUser(t.ctx, { email: 'owner@example.com' });
    const other = await createUser(t.ctx, { email: 'other@example.com' });
    const browser = await signIn(t.app, owner.email);
    const otherBrowser = await signIn(t.app, other.email);
    const bytes = await jpeg({ r: 9, g: 9, b: 9 });
    const form = multipart(
      { checksum: sha1(bytes), filename: 'one.jpg', capturedAt: '2025-01-02T12:00:00.000Z' },
      { name: 'one.jpg', type: 'image/jpeg', bytes },
    );
    const created = await browser.fetch('/api/assets', {
      method: 'POST',
      headers: { 'content-type': form.contentType },
      body: form.body,
    });
    const { assetId } = (await created.json()) as { assetId: string };

    const theirs = await otherBrowser.call('assets.update', {
      body: { ids: [assetId], isFavorite: true },
    });
    expect(theirs.data.updated).toBe(0);

    const trashed = await browser.call('assets.update', {
      body: { ids: [assetId], isTrashed: true },
    });
    expect(trashed.data.updated).toBe(1);
    const library = await browser.call('timeline.buckets', {
      query: { scope: 'library', withShared: 'false' },
    });
    expect(library.data.buckets).toEqual([]);
    const trash = await browser.call('timeline.bucket', {
      params: { key: '2025-01' },
      query: { scope: 'trash', withShared: 'false' },
    });
    expect(trash.data.assets.map((asset) => asset.id)).toEqual([assetId]);

    const restored = await browser.call('assets.update', {
      body: { ids: [assetId], isTrashed: false, isArchived: true },
    });
    expect(restored.data.updated).toBe(1);
    const archive = await browser.call('timeline.buckets', {
      query: { scope: 'archive', withShared: 'true' },
    });
    expect(archive.data.buckets).toEqual([{ key: '2025-01', count: 1 }]);
  });
});
