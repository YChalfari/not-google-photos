import { FACE_EMBEDDING_DIMENSIONS } from '@ngp/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { syncAlbumRulesForAsset } from '../src/albums/rules';
import { albumAssets, albums, assets, faces } from '../src/db/schema';
import {
  createUser,
  insertAlbum,
  insertAsset,
  insertFace,
  insertPerson,
  signIn,
} from './support/factories';
import { addAlbumMember } from './support/factories';
import { createTestServer, type TestServer } from './support/server';

let t: TestServer;

beforeAll(async () => {
  t = await createTestServer();
});
afterAll(() => t.close());

function embedding(index: number): number[] {
  const values = Array.from({ length: FACE_EMBEDDING_DIMENSIONS }, () => 0);
  values[index] = 1;
  return values;
}

describe('live albums', () => {
  it('adds a person’s photos, suggests the same face in another library, and does not merge them', async () => {
    const alex = await createUser(t.ctx, { email: 'alex-rules@example.com', name: 'Alex' });
    const sam = await createUser(t.ctx, { email: 'sam-rules@example.com', name: 'Sam' });
    const pat = await createUser(t.ctx, { email: 'pat-rules@example.com', name: 'Pat' });
    const stranger = await createUser(t.ctx, { email: 'no-rules@example.com', name: 'No' });
    const alexBrowser = await signIn(t.app, alex.email);
    const samBrowser = await signIn(t.app, sam.email);
    const patBrowser = await signIn(t.app, pat.email);
    const strangerBrowser = await signIn(t.app, stranger.email);

    const recent = await insertAsset(t.ctx, alex.id, {
      capturedAt: new Date('2024-06-01T12:00:00Z'),
    });
    const older = await insertAsset(t.ctx, alex.id, {
      capturedAt: new Date('2018-06-01T12:00:00Z'),
    });
    const trashed = await insertAsset(t.ctx, alex.id, { trashed: true });
    const manual = await insertAsset(t.ctx, alex.id);
    const samPhoto = await insertAsset(t.ctx, sam.id);
    const alexPerson = await insertPerson(t.ctx, alex.id, 'Maya');
    const samPerson = await insertPerson(t.ctx, sam.id, 'Maya');

    for (const assetId of [recent.id, older.id, trashed.id]) {
      const face = await insertFace(t.ctx, { assetId, ownerId: alex.id, personId: alexPerson.id });
      await t.ctx.db
        .update(faces)
        .set({ embedding: embedding(3), quality: 0.95 })
        .where(eq(faces.id, face.id));
    }
    const samFace = await insertFace(t.ctx, {
      assetId: samPhoto.id,
      ownerId: sam.id,
      personId: samPerson.id,
    });
    await t.ctx.db
      .update(faces)
      .set({ embedding: embedding(3), quality: 0.95 })
      .where(eq(faces.id, samFace.id));

    const album = await insertAlbum(t.ctx, alex.id, 'Maya');
    await addAlbumMember(t.ctx, album.id, sam.id, { role: 'contributor' });
    await addAlbumMember(t.ctx, album.id, pat.id, { role: 'viewer' });
    await t.ctx.db.insert(albumAssets).values({
      albumId: album.id,
      assetId: manual.id,
      addedById: alex.id,
      source: 'manual',
    });

    const added = await alexBrowser.call('albums.rules.add', {
      params: { id: album.id },
      body: { personId: alexPerson.id, startDate: '2020-01-01' },
    });
    expect(added.status, JSON.stringify(added.error)).toBe(201);
    expect(added.data.rule.person).toMatchObject({ id: alexPerson.id, name: 'Maya' });
    const photos = await alexBrowser.call('albums.assets', { params: { id: album.id } });
    expect(photos.data.items.map((item) => item.id).sort()).toEqual([manual.id, recent.id].sort());
    const live = await t.ctx.db
      .select({ isLive: albums.isLive })
      .from(albums)
      .where(eq(albums.id, album.id));
    expect(live[0]?.isLive).toBe(true);

    const again = await alexBrowser.call('albums.rules.add', {
      params: { id: album.id },
      body: { personId: alexPerson.id },
    });
    expect(again.status).toBe(409);
    const notMine = await alexBrowser.call('albums.rules.add', {
      params: { id: album.id },
      body: { personId: samPerson.id },
    });
    expect(notMine.status).toBe(404);
    const viewer = await patBrowser.call('albums.rules.add', {
      params: { id: album.id },
      body: { personId: alexPerson.id },
    });
    expect(viewer.status).toBe(403);
    const missing = await strangerBrowser.call('albums.rules.add', {
      params: { id: album.id },
      body: { personId: alexPerson.id },
    });
    expect(missing.status).toBe(404);

    const ideas = await samBrowser.call('albums.ruleSuggestions', { params: { id: album.id } });
    expect(ideas.status, JSON.stringify(ideas.error)).toBe(200);
    expect(ideas.data.suggestions).toHaveLength(1);
    expect(ideas.data.suggestions[0]).toMatchObject({
      sharedBy: { id: alex.id, name: 'Alex' },
      sharedPersonName: 'Maya',
      candidate: { id: samPerson.id, name: 'Maya' },
    });
    expect(ideas.data.suggestions[0]?.similarity).toBeGreaterThan(0.9);

    const confirmed = await samBrowser.call('albums.rules.add', {
      params: { id: album.id },
      body: { personId: samPerson.id },
    });
    expect(confirmed.status).toBe(201);
    const withSam = await alexBrowser.call('albums.assets', { params: { id: album.id } });
    expect(withSam.data.items.map((item) => item.id)).toContain(samPhoto.id);
    const samPeople = await t.ctx.db.select().from(faces).where(eq(faces.ownerId, sam.id));
    expect(samPeople.every((face) => face.personId === samPerson.id)).toBe(true);

    const later = await insertAsset(t.ctx, alex.id, {
      capturedAt: new Date('2024-08-01T12:00:00Z'),
    });
    const laterFace = await insertFace(t.ctx, {
      assetId: later.id,
      ownerId: alex.id,
      personId: alexPerson.id,
    });
    await t.ctx.db
      .update(faces)
      .set({ embedding: embedding(3) })
      .where(eq(faces.id, laterFace.id));
    await syncAlbumRulesForAsset(t.ctx.db, later.id);
    const after = await alexBrowser.call('albums.assets', { params: { id: album.id } });
    expect(after.data.items.map((item) => item.id)).toContain(later.id);

    const removed = await alexBrowser.call('albums.rules.remove', {
      params: { id: album.id, ruleId: added.data.rule.id },
    });
    expect(removed.status).toBe(204);
    const remaining = await alexBrowser.call('albums.assets', { params: { id: album.id } });
    const remainingIds = remaining.data.items.map((item) => item.id);
    expect(remainingIds).toContain(manual.id);
    expect(remainingIds).toContain(samPhoto.id);
    expect(remainingIds).not.toContain(recent.id);
    expect(remainingIds).not.toContain(older.id);

    const stillThere = await t.ctx.db
      .select({ id: assets.id })
      .from(assets)
      .where(eq(assets.id, recent.id));
    expect(stillThere).toHaveLength(1);
  });

  it('includes someone only when another person in the album is with them', async () => {
    const alex = await createUser(t.ctx, { email: 'alex-together@example.com', name: 'Alex' });
    const browser = await signIn(t.app, alex.email);
    const me = await insertPerson(t.ctx, alex.id, 'Alex');
    const wife = await insertPerson(t.ctx, alex.id, 'Sam');
    const kid = await insertPerson(t.ctx, alex.id, 'Max');
    const stranger = await insertPerson(t.ctx, alex.id, 'Pat');
    const alone = await insertAsset(t.ctx, alex.id);
    const withWife = await insertAsset(t.ctx, alex.id);
    const withStranger = await insertAsset(t.ctx, alex.id);
    const wifeAlone = await insertAsset(t.ctx, alex.id);
    const kidAlone = await insertAsset(t.ctx, alex.id);
    const kidWithMe = await insertAsset(t.ctx, alex.id);
    const ignoredCompany = await insertAsset(t.ctx, alex.id);
    await insertFace(t.ctx, { assetId: alone.id, ownerId: alex.id, personId: me.id });
    await insertFace(t.ctx, { assetId: withWife.id, ownerId: alex.id, personId: me.id });
    await insertFace(t.ctx, { assetId: withWife.id, ownerId: alex.id, personId: wife.id });
    await insertFace(t.ctx, { assetId: withStranger.id, ownerId: alex.id, personId: me.id });
    await insertFace(t.ctx, { assetId: withStranger.id, ownerId: alex.id, personId: stranger.id });
    await insertFace(t.ctx, { assetId: wifeAlone.id, ownerId: alex.id, personId: wife.id });
    await insertFace(t.ctx, { assetId: kidAlone.id, ownerId: alex.id, personId: kid.id });
    await insertFace(t.ctx, { assetId: kidWithMe.id, ownerId: alex.id, personId: kid.id });
    await insertFace(t.ctx, { assetId: kidWithMe.id, ownerId: alex.id, personId: me.id });
    await insertFace(t.ctx, { assetId: ignoredCompany.id, ownerId: alex.id, personId: me.id });
    const ignored = await insertFace(t.ctx, {
      assetId: ignoredCompany.id,
      ownerId: alex.id,
      personId: wife.id,
    });
    await t.ctx.db.update(faces).set({ ignored: true }).where(eq(faces.id, ignored.id));

    const album = await insertAlbum(t.ctx, alex.id, 'Family');
    const addedKid = await browser.call('albums.rules.add', {
      params: { id: album.id },
      body: { personId: kid.id },
    });
    expect(addedKid.status, JSON.stringify(addedKid.error)).toBe(201);
    expect(addedKid.data.rule.together).toBe(false);

    const kidPhotos = await browser.call('albums.assets', { params: { id: album.id } });
    expect(kidPhotos.data.items.map((item) => item.id).sort()).toEqual(
      [kidAlone.id, kidWithMe.id].sort(),
    );

    const addedMe = await browser.call('albums.rules.add', {
      params: { id: album.id },
      body: { personId: me.id, together: true },
    });
    expect(addedMe.status, JSON.stringify(addedMe.error)).toBe(201);
    expect(addedMe.data.rule.together).toBe(true);
    const withMe = await browser.call('albums.assets', { params: { id: album.id } });
    expect(withMe.data.items.map((item) => item.id).sort()).toEqual(
      [kidAlone.id, kidWithMe.id].sort(),
    );

    const addedWife = await browser.call('albums.rules.add', {
      params: { id: album.id },
      body: { personId: wife.id },
    });
    expect(addedWife.status).toBe(201);
    const withWifeRule = await browser.call('albums.assets', { params: { id: album.id } });
    expect(withWifeRule.data.items.map((item) => item.id).sort()).toEqual(
      [kidAlone.id, kidWithMe.id, wifeAlone.id, withWife.id].sort(),
    );

    const later = await insertAsset(t.ctx, alex.id);
    await insertFace(t.ctx, { assetId: later.id, ownerId: alex.id, personId: me.id });
    await insertFace(t.ctx, { assetId: later.id, ownerId: alex.id, personId: wife.id });
    await syncAlbumRulesForAsset(t.ctx.db, later.id);
    const afterSync = await browser.call('albums.assets', { params: { id: album.id } });
    expect(afterSync.data.items.map((item) => item.id)).toContain(later.id);

    const opened = await browser.call('albums.rules.update', {
      params: { id: album.id, ruleId: addedMe.data.rule.id },
      body: { together: false },
    });
    expect(opened.status, JSON.stringify(opened.error)).toBe(200);
    const allOfMe = await browser.call('albums.assets', { params: { id: album.id } });
    const allIds = allOfMe.data.items.map((item) => item.id);
    expect(allIds).toEqual(
      expect.arrayContaining([alone.id, withStranger.id, ignoredCompany.id, withWife.id]),
    );

    const closed = await browser.call('albums.rules.update', {
      params: { id: album.id, ruleId: addedMe.data.rule.id },
      body: { together: true },
    });
    expect(closed.status).toBe(200);
    const tightened = await browser.call('albums.assets', { params: { id: album.id } });
    expect(tightened.data.items.map((item) => item.id).sort()).toEqual(
      [kidAlone.id, kidWithMe.id, wifeAlone.id, withWife.id, later.id].sort(),
    );

    const removedWife = await browser.call('albums.rules.remove', {
      params: { id: album.id, ruleId: addedWife.data.rule.id },
    });
    expect(removedWife.status).toBe(204);
    const withoutWife = await browser.call('albums.assets', { params: { id: album.id } });
    expect(withoutWife.data.items.map((item) => item.id).sort()).toEqual(
      [kidAlone.id, kidWithMe.id].sort(),
    );
  });
});
