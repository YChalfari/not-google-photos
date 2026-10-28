import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assets } from '../src/db/schema';
import { createUser, insertAsset, signIn } from './support/factories';
import { createTestServer, type TestServer } from './support/server';

let t: TestServer;

beforeAll(async () => {
  t = await createTestServer();
});
afterAll(() => t.close());

describe('albums', () => {
  it('lets the owner share an album, and keeps the photos when the album is deleted', async () => {
    const alex = await createUser(t.ctx, { email: 'alex-albums@example.com', name: 'Alex' });
    const sam = await createUser(t.ctx, { email: 'sam-albums@example.com', name: 'Sam' });
    const stranger = await createUser(t.ctx, { email: 'pat-albums@example.com', name: 'Pat' });
    const alexBrowser = await signIn(t.app, alex.email);
    const samBrowser = await signIn(t.app, sam.email);
    const patBrowser = await signIn(t.app, stranger.email);

    const alexPhoto = await insertAsset(t.ctx, alex.id);
    const samPhoto = await insertAsset(t.ctx, sam.id);
    const created = await alexBrowser.call('albums.create', {
      body: {
        title: 'Weekends',
        description: 'Out of the house',
        assetIds: [alexPhoto.id, samPhoto.id],
      },
    });
    expect(created.status, JSON.stringify(created.error)).toBe(201);
    expect(created.data.album.role).toBe('owner');
    expect(created.data.album.assetCount).toBe(1);
    expect(created.data.album.invited).toBe(false);
    const albumId = created.data.album.id;

    const hidden = await samBrowser.call('albums.list');
    expect(hidden.data.albums).toEqual([]);
    const missing = await samBrowser.call('albums.get', { params: { id: albumId } });
    expect(missing.status).toBe(404);

    const invite = await alexBrowser.call('albums.members.add', {
      params: { id: albumId },
      body: { userId: sam.id, role: 'viewer' },
    });
    expect(invite.status, JSON.stringify(invite.error)).toBe(201);
    expect(invite.data.member.status).toBe('invited');
    const again = await alexBrowser.call('albums.members.add', {
      params: { id: albumId },
      body: { userId: sam.id, role: 'viewer' },
    });
    expect(again.status).toBe(409);

    const pending = await samBrowser.call('albums.list');
    expect(pending.data.albums.map((album) => album.id)).toEqual([albumId]);
    expect(pending.data.albums[0]?.invited).toBe(true);
    const beforeJoin = await samBrowser.call('albums.assets', { params: { id: albumId } });
    expect(beforeJoin.status).toBe(404);

    const joined = await samBrowser.call('albums.join', { params: { id: albumId } });
    expect(joined.status, JSON.stringify(joined.error)).toBe(200);
    expect(joined.data.album.invited).toBe(false);
    expect(joined.data.album.role).toBe('viewer');
    const photos = await samBrowser.call('albums.assets', { params: { id: albumId } });
    expect(photos.status).toBe(200);
    expect(photos.data.items.map((item) => item.id)).toEqual([alexPhoto.id]);

    const viewerAdd = await samBrowser.call('albums.addAssets', {
      params: { id: albumId },
      body: { assetIds: [samPhoto.id] },
    });
    expect(viewerAdd.status).toBe(403);

    const promoted = await alexBrowser.call('albums.members.update', {
      params: { id: albumId, userId: sam.id },
      body: { role: 'contributor' },
    });
    expect(promoted.status).toBe(200);
    expect(promoted.data.member.role).toBe('contributor');
    const added = await samBrowser.call('albums.addAssets', {
      params: { id: albumId },
      body: { assetIds: [samPhoto.id, alexPhoto.id] },
    });
    expect(added.status).toBe(200);
    expect(added.data.added).toBe(1);

    const timeline = await samBrowser.call('albums.members.update', {
      params: { id: albumId, userId: sam.id },
      body: { showInTimeline: true },
    });
    expect(timeline.status).toBe(200);
    expect(timeline.data.member.showInTimeline).toBe(true);
    const ownerTimeline = await alexBrowser.call('albums.members.update', {
      params: { id: albumId, userId: sam.id },
      body: { showInTimeline: false },
    });
    expect(ownerTimeline.status).toBe(403);

    const strangerDelete = await patBrowser.call('albums.delete', { params: { id: albumId } });
    expect(strangerDelete.status).toBe(404);
    const memberDelete = await samBrowser.call('albums.delete', { params: { id: albumId } });
    expect(memberDelete.status).toBe(403);

    const removed = await alexBrowser.call('albums.removeAssets', {
      params: { id: albumId },
      body: { assetIds: [samPhoto.id] },
    });
    expect(removed.data.removed).toBe(1);
    const contributorRemove = await samBrowser.call('albums.removeAssets', {
      params: { id: albumId },
      body: { assetIds: [alexPhoto.id] },
    });
    expect(contributorRemove.data.removed).toBe(0);

    const deleted = await alexBrowser.call('albums.delete', { params: { id: albumId } });
    expect(deleted.status).toBe(204);
    const stillThere = await alexBrowser.call('assets.get', { params: { id: alexPhoto.id } });
    expect(stillThere.status).toBe(200);
    const [row] = await t.ctx.db
      .select({ id: assets.id })
      .from(assets)
      .where(eq(assets.id, alexPhoto.id));
    expect(row?.id).toBe(alexPhoto.id);
  });

  it('lets an invited person decline', async () => {
    const alex = await createUser(t.ctx, { email: 'alex-decline@example.com' });
    const sam = await createUser(t.ctx, { email: 'sam-decline@example.com' });
    const alexBrowser = await signIn(t.app, alex.email);
    const samBrowser = await signIn(t.app, sam.email);
    const created = await alexBrowser.call('albums.create', { body: { title: 'Later' } });
    const albumId = created.data.album.id;
    await alexBrowser.call('albums.members.add', {
      params: { id: albumId },
      body: { userId: sam.id, role: 'viewer' },
    });
    const declined = await samBrowser.call('albums.members.remove', {
      params: { id: albumId, userId: sam.id },
    });
    expect(declined.status).toBe(204);
    const list = await samBrowser.call('albums.list');
    expect(list.data.albums).toEqual([]);
  });
});
