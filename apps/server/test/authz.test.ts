/**
 * Two accounts, Alex and Sam. Nothing Alex owns is visible to Sam until Alex shares it through an
 * album, and only what's in that album: never other photos, people, or faces.
 */
import { randomBytes } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  assetInTimelineOf,
  assetVisibleTo,
  canContributeToAlbum,
  canViewAlbum,
  canViewAsset,
  canViewPerson,
  faceVisibleTo,
  filterOwnedAssetIds,
  filterVisibleAssetIds,
  personVisibleTo,
  visibleFacesOnAsset,
} from '../src/authz/access';
import {
  albumMembers,
  albumRules,
  assets,
  faces,
  files,
  people,
  users,
  type AssetRow,
} from '../src/db/schema';
import { TestClient } from './support/client';
import {
  addAlbumAsset,
  addAlbumMember,
  addAlbumRule,
  createUser,
  insertAlbum,
  insertAsset,
  insertDerivedFile,
  insertFace,
  insertPerson,
  signIn,
} from './support/factories';
import { createTestServer, type TestServer } from './support/server';

let t: TestServer;
let alexId: string;
let samId: string;
let alex: TestClient;
let sam: TestClient;

/** Alex's photos: in the shared album, private, and trashed-but-in-the-album. */
let inAlbum: AssetRow;
let privatePhoto: AssetRow;
let trashedInAlbum: AssetRow;
let samsPhoto: AssetRow;
const inAlbumBytes = randomBytes(4096);

let noa: { id: string };
let ben: { id: string };
let samsPerson: { id: string };
let noaOnAlbumPhoto: { id: string };
let noaOnPrivatePhoto: { id: string };
let benOnAlbumPhoto: { id: string };
let albumId: string;

async function visibleIds(userId: string) {
  const rows = await t.ctx.db.select({ id: assets.id }).from(assets).where(assetVisibleTo(userId));
  return new Set(rows.map((row) => row.id));
}

async function visiblePeople(userId: string) {
  const rows = await t.ctx.db.select({ id: people.id }).from(people).where(personVisibleTo(userId));
  return new Set(rows.map((row) => row.id));
}

async function visibleFaces(userId: string) {
  const rows = await t.ctx.db.select({ id: faces.id }).from(faces).where(faceVisibleTo(userId));
  return new Set(rows.map((row) => row.id));
}

async function signUrl(
  client: TestClient,
  assetId: string,
  variant: 'original' | 'thumbnail' | 'preview' = 'original',
) {
  const result = await client.call('media.sign', { body: { items: [{ assetId, variant }] } });
  expect(result.status).toBe(200);
  return result.data.urls[0]?.url;
}

beforeAll(async () => {
  t = await createTestServer();
  alexId = (await createUser(t.ctx, { email: 'alex@example.com', name: 'Alex', role: 'admin' })).id;
  samId = (await createUser(t.ctx, { email: 'sam@example.com', name: 'Sam' })).id;
  alex = await signIn(t.app, 'alex@example.com');
  sam = await signIn(t.app, 'sam@example.com');

  inAlbum = await insertAsset(t.ctx, alexId, { bytes: inAlbumBytes, filename: 'beach.jpg' });
  privatePhoto = await insertAsset(t.ctx, alexId, { filename: 'private.jpg' });
  trashedInAlbum = await insertAsset(t.ctx, alexId, { trashed: true });
  samsPhoto = await insertAsset(t.ctx, samId);
  await insertDerivedFile(t.ctx, inAlbum.id, 'thumbnail');

  noa = await insertPerson(t.ctx, alexId, 'Noa');
  ben = await insertPerson(t.ctx, alexId, 'Ben');
  samsPerson = await insertPerson(t.ctx, samId, 'Noa (Sam)');
  noaOnAlbumPhoto = await insertFace(t.ctx, {
    assetId: inAlbum.id,
    ownerId: alexId,
    personId: noa.id,
  });
  noaOnPrivatePhoto = await insertFace(t.ctx, {
    assetId: privatePhoto.id,
    ownerId: alexId,
    personId: noa.id,
  });
  benOnAlbumPhoto = await insertFace(t.ctx, {
    assetId: inAlbum.id,
    ownerId: alexId,
    personId: ben.id,
  });
  await insertFace(t.ctx, { assetId: samsPhoto.id, ownerId: samId, personId: samsPerson.id });

  const album = await insertAlbum(t.ctx, alexId, 'Family', true);
  albumId = album.id;
  await addAlbumAsset(t.ctx, albumId, inAlbum.id, alexId);
  await addAlbumAsset(t.ctx, albumId, trashedInAlbum.id, alexId);
});
afterAll(() => t.close());

describe('before anything is shared', () => {
  it('each person sees only their own photos (owners see their trash too)', async () => {
    expect(await visibleIds(alexId)).toEqual(
      new Set([inAlbum.id, privatePhoto.id, trashedInAlbum.id]),
    );
    expect(await visibleIds(samId)).toEqual(new Set([samsPhoto.id]));
    expect(await canViewAsset(t.ctx.db, samId, inAlbum.id)).toBe(false);
    expect(
      await filterVisibleAssetIds(t.ctx.db, samId, [inAlbum.id, privatePhoto.id, samsPhoto.id]),
    ).toEqual(new Set([samsPhoto.id]));
  });

  it('people and faces stay in their own library', async () => {
    expect(await visiblePeople(samId)).toEqual(new Set([samsPerson.id]));
    expect(await visiblePeople(alexId)).toEqual(new Set([noa.id, ben.id]));
    expect(await canViewPerson(t.ctx.db, samId, noa.id)).toBe(false);
    const samFaces = await visibleFaces(samId);
    expect(samFaces.has(noaOnAlbumPhoto.id)).toBe(false);
    expect(samFaces.size).toBe(1);
  });

  it("the album isn't visible to Sam", async () => {
    expect(await canViewAlbum(t.ctx.db, samId, albumId)).toBe(false);
    expect(await canViewAlbum(t.ctx.db, alexId, albumId)).toBe(true);
  });

  it("signing URLs for someone else's photos returns nothing", async () => {
    const result = await sam.call('media.sign', {
      body: {
        items: [
          { assetId: inAlbum.id, variant: 'original' },
          { assetId: privatePhoto.id, variant: 'thumbnail' },
        ],
      },
    });
    expect(result.status).toBe(200);
    expect(result.data.urls).toEqual([]);
  });

  it('a URL signed for Sam still fails, because access is checked on every request', async () => {
    const forged = t.ctx.media.sign({ assetId: inAlbum.id, variant: 'original', userId: samId });
    const res = await new TestClient(t.app).fetch(forged.url);
    expect(res.status).toBe(404);
  });
});

describe('signed media URLs', () => {
  it('serve the bytes with caching headers, and work without cookies', async () => {
    const url = await signUrl(alex, inAlbum.id);
    expect(url).toMatch(
      new RegExp(`^/api/media/${inAlbum.id}/original\\?exp=\\d+&uid=${alexId}&sig=`),
    );
    const res = await new TestClient(t.app).fetch(url!);
    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer())).toEqual(inAlbumBytes);
    const [file] = await t.ctx.db.select().from(files).where(eq(files.id, inAlbum.fileId));
    expect(res.headers.get('etag')).toBe(`"${file!.sha256}"`);
    expect(res.headers.get('content-type')).toBe('image/jpeg');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-security-policy')).toContain('sandbox');
    expect(res.headers.get('cross-origin-resource-policy')).toBe('cross-origin');
    expect(res.headers.get('content-disposition')).toContain('beach.jpg');
  });

  it('support Range, If-None-Match, and HEAD', async () => {
    const url = (await signUrl(alex, inAlbum.id))!;
    const client = new TestClient(t.app);
    const partial = await client.fetch(url, { headers: { range: 'bytes=10-19' } });
    expect(partial.status).toBe(206);
    expect(partial.headers.get('content-range')).toBe(`bytes 10-19/${inAlbumBytes.length}`);
    expect(Buffer.from(await partial.arrayBuffer())).toEqual(inAlbumBytes.subarray(10, 20));

    const suffix = await client.fetch(url, { headers: { range: 'bytes=-5' } });
    expect(Buffer.from(await suffix.arrayBuffer())).toEqual(inAlbumBytes.subarray(-5));

    const outOfRange = await client.fetch(url, { headers: { range: 'bytes=999999-' } });
    expect(outOfRange.status).toBe(416);

    const etag = partial.headers.get('etag')!;
    const cached = await client.fetch(url, { headers: { 'if-none-match': etag } });
    expect(cached.status).toBe(304);

    const head = await client.fetch(url, { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(head.headers.get('content-length')).toBe(String(inAlbumBytes.length));
    expect((await head.arrayBuffer()).byteLength).toBe(0);
  });

  it('only include variants that exist', async () => {
    const result = await alex.call('media.sign', {
      body: {
        items: [
          { assetId: inAlbum.id, variant: 'thumbnail' },
          { assetId: inAlbum.id, variant: 'preview' },
        ],
      },
    });
    expect(result.data.urls.map((url) => url.variant)).toEqual(['thumbnail']);
    const res = await new TestClient(t.app).fetch(result.data.urls[0]!.url);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/webp');
  });

  it('reject tampering and expiry', async () => {
    const url = new URL((await signUrl(alex, inAlbum.id))!, 'http://ngp.test');
    const client = new TestClient(t.app);

    const otherUser = new URL(url);
    otherUser.searchParams.set('uid', samId);
    expect((await client.fetch(otherUser.pathname + otherUser.search)).status).toBe(403);

    const otherAsset = new URL(url);
    otherAsset.pathname = `/api/media/${privatePhoto.id}/original`;
    expect((await client.fetch(otherAsset.pathname + otherAsset.search)).status).toBe(403);

    const otherVariant = new URL(url);
    otherVariant.pathname = `/api/media/${inAlbum.id}/preview`;
    expect((await client.fetch(otherVariant.pathname + otherVariant.search)).status).toBe(403);

    const longer = new URL(url);
    longer.searchParams.set('exp', String(Number(url.searchParams.get('exp')) + 86_400));
    expect((await client.fetch(longer.pathname + longer.search)).status).toBe(403);

    const old = t.ctx.media.sign(
      { assetId: inAlbum.id, variant: 'original', userId: alexId },
      Date.now() - 86_400_000,
    );
    const expired = await client.fetch(old.url);
    expect(expired.status).toBe(403);
    const body = (await expired.json()) as { error?: { message?: string } };
    expect(body.error?.message ?? '').toContain('expired');
  });
});

describe('sharing an album', () => {
  it('a pending invitation grants nothing', async () => {
    await addAlbumMember(t.ctx, albumId, samId, { accepted: false });
    expect(await canViewAlbum(t.ctx.db, samId, albumId)).toBe(false);
    expect(await visibleIds(samId)).toEqual(new Set([samsPhoto.id]));
    expect(await signUrl(sam, inAlbum.id)).toBeUndefined();
  });

  it('after accepting, Sam sees the album photos but nothing else of Alex', async () => {
    await t.ctx.db
      .update(albumMembers)
      .set({ acceptedAt: new Date() })
      .where(and(eq(albumMembers.albumId, albumId), eq(albumMembers.userId, samId)));

    expect(await canViewAlbum(t.ctx.db, samId, albumId)).toBe(true);
    expect(await visibleIds(samId)).toEqual(new Set([samsPhoto.id, inAlbum.id]));
    // Trashed by its owner: gone from the shared album too.
    expect(await canViewAsset(t.ctx.db, samId, trashedInAlbum.id)).toBe(false);
    expect(await canViewAsset(t.ctx.db, samId, privatePhoto.id)).toBe(false);

    const url = await signUrl(sam, inAlbum.id);
    expect(url).toContain(`uid=${samId}`);
    expect((await new TestClient(t.app).fetch(url!)).status).toBe(200);
    expect(await signUrl(sam, privatePhoto.id)).toBeUndefined();
  });

  it('sharing never makes Sam an owner', async () => {
    expect(await filterOwnedAssetIds(t.ctx.db, samId, [inAlbum.id, samsPhoto.id])).toEqual(
      new Set([samsPhoto.id]),
    );
    expect(await canContributeToAlbum(t.ctx.db, samId, albumId)).toBe(false);
    expect(await canContributeToAlbum(t.ctx.db, alexId, albumId)).toBe(true);
    await t.ctx.db
      .update(albumMembers)
      .set({ role: 'contributor' })
      .where(and(eq(albumMembers.albumId, albumId), eq(albumMembers.userId, samId)));
    expect(await canContributeToAlbum(t.ctx.db, samId, albumId)).toBe(true);
  });

  it('people and faces stay private until a person is linked to the live album', async () => {
    expect(await visiblePeople(samId)).toEqual(new Set([samsPerson.id]));
    expect((await visibleFaces(samId)).has(noaOnAlbumPhoto.id)).toBe(false);

    await addAlbumRule(t.ctx, albumId, alexId, noa.id);

    expect(await visiblePeople(samId)).toEqual(new Set([samsPerson.id, noa.id]));
    expect(await canViewPerson(t.ctx.db, samId, ben.id)).toBe(false);
    const samFaces = await visibleFaces(samId);
    expect(samFaces.has(noaOnAlbumPhoto.id)).toBe(true);
    expect(samFaces.has(noaOnPrivatePhoto.id)).toBe(false);
    expect(samFaces.has(benOnAlbumPhoto.id)).toBe(false);

    const onPhoto = await visibleFacesOnAsset(t.ctx.db, samId, inAlbum.id);
    expect(onPhoto.map((face) => face.id)).toEqual([noaOnAlbumPhoto.id]);
    const alexSees = await visibleFacesOnAsset(t.ctx.db, alexId, inAlbum.id);
    expect(alexSees.map((face) => face.id).sort()).toEqual(
      [noaOnAlbumPhoto.id, benOnAlbumPhoto.id].sort(),
    );
  });

  it('shared photos join the timeline only when the member turns it on', async () => {
    const timeline = async () => {
      const rows = await t.ctx.db
        .select({ id: assets.id })
        .from(assets)
        .where(assetInTimelineOf(samId));
      return new Set(rows.map((row) => row.id));
    };
    expect(await timeline()).toEqual(new Set([samsPhoto.id]));
    await t.ctx.db
      .update(albumMembers)
      .set({ showInTimeline: true })
      .where(and(eq(albumMembers.albumId, albumId), eq(albumMembers.userId, samId)));
    expect(await timeline()).toEqual(new Set([samsPhoto.id, inAlbum.id]));
  });

  it('trashing, disabling, and un-sharing take effect immediately, even for issued URLs', async () => {
    const url = (await signUrl(sam, inAlbum.id))!;
    const client = new TestClient(t.app);
    expect((await client.fetch(url)).status).toBe(200);

    await t.ctx.db.update(assets).set({ trashedAt: new Date() }).where(eq(assets.id, inAlbum.id));
    expect((await client.fetch(url)).status).toBe(404);
    await t.ctx.db.update(assets).set({ trashedAt: null }).where(eq(assets.id, inAlbum.id));
    expect((await client.fetch(url)).status).toBe(200);

    await t.ctx.db.update(users).set({ disabledAt: new Date() }).where(eq(users.id, samId));
    expect((await client.fetch(url)).status).toBe(403);
    await t.ctx.db.update(users).set({ disabledAt: null }).where(eq(users.id, samId));

    await t.ctx.db
      .delete(albumMembers)
      .where(and(eq(albumMembers.albumId, albumId), eq(albumMembers.userId, samId)));
    expect((await client.fetch(url)).status).toBe(404);
    expect(await visiblePeople(samId)).toEqual(new Set([samsPerson.id]));
    expect((await visibleFaces(samId)).has(noaOnAlbumPhoto.id)).toBe(false);
  });
});

async function expectRefusedBy(query: PromiseLike<unknown>, constraint: string) {
  const error: unknown = await Promise.resolve(query).then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error, `expected ${constraint} to refuse the write`).toBeDefined();
  expect((error as { cause?: { constraint?: string } }).cause?.constraint).toBe(constraint);
}

describe('the database refuses cross-account links', () => {
  const box = { boxX: 0, boxY: 0, boxWidth: 0.1, boxHeight: 0.1 };

  it("a face can't belong to another account's person or photo", async () => {
    await expectRefusedBy(
      t.ctx.db
        .insert(faces)
        .values({ assetId: inAlbum.id, ownerId: alexId, personId: samsPerson.id, ...box }),
      'faces_person_owner_fk',
    );
    await expectRefusedBy(
      t.ctx.db.insert(faces).values({ assetId: samsPhoto.id, ownerId: alexId, ...box }),
      'faces_asset_owner_fk',
    );
    await expectRefusedBy(
      t.ctx.db
        .update(faces)
        .set({ personId: samsPerson.id })
        .where(eq(faces.id, noaOnAlbumPhoto.id)),
      'faces_person_owner_fk',
    );
  });

  it("a live-album rule can only link the member's own person", async () => {
    await expectRefusedBy(
      t.ctx.db.insert(albumRules).values({ albumId, userId: samId, personId: ben.id }),
      'album_rules_person_owner_fk',
    );
  });

  it("an edited copy can't point at another account's original", async () => {
    await expectRefusedBy(
      t.ctx.db.update(assets).set({ versionOfId: inAlbum.id }).where(eq(assets.id, samsPhoto.id)),
      'assets_version_of_owner_fk',
    );
    await t.ctx.db
      .update(assets)
      .set({ versionOfId: inAlbum.id })
      .where(eq(assets.id, privatePhoto.id));
  });
});

describe('identical files across accounts', () => {
  it('are stored once, and each account keeps its own asset', async () => {
    const bytes = randomBytes(2048);
    const alexCopy = await insertAsset(t.ctx, alexId, { bytes });
    const samCopy = await insertAsset(t.ctx, samId, { bytes });
    expect(alexCopy.fileId).toBe(samCopy.fileId);
    const [file] = await t.ctx.db.select().from(files).where(eq(files.id, alexCopy.fileId));
    expect(file?.refCount).toBe(2);

    expect(await canViewAsset(t.ctx.db, samId, alexCopy.id)).toBe(false);
    expect(await canViewAsset(t.ctx.db, samId, samCopy.id)).toBe(true);

    await t.ctx.db.delete(assets).where(inArray(assets.id, [samCopy.id]));
    const [after] = await t.ctx.db.select().from(files).where(eq(files.id, alexCopy.fileId));
    expect(after?.refCount).toBe(1);
  });
});
