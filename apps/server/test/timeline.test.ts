import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addAlbumAsset,
  addAlbumMember,
  createUser,
  insertAlbum,
  insertAsset,
  signIn,
} from './support/factories';
import { createTestServer, type TestServer } from './support/server';

let t: TestServer;

beforeAll(async () => {
  t = await createTestServer();
});
afterAll(() => t.close());

describe('timeline', () => {
  it('groups your photos by month and includes shared albums you turned on', async () => {
    const alex = await createUser(t.ctx, { email: 'alex@example.com', role: 'admin' });
    const sam = await createUser(t.ctx, { email: 'sam@example.com' });
    const june = await insertAsset(t.ctx, alex.id, {
      filename: 'june.jpg',
      capturedAt: new Date('2024-06-15T12:00:00Z'),
    });
    const october = await insertAsset(t.ctx, alex.id, {
      filename: 'october.jpg',
      capturedAt: new Date('2024-10-02T12:00:00Z'),
    });
    await insertAsset(t.ctx, sam.id, {
      filename: 'sam.jpg',
      capturedAt: new Date('2024-10-03T12:00:00Z'),
    });
    const album = await insertAlbum(t.ctx, alex.id, 'Weekends');
    await addAlbumMember(t.ctx, album.id, sam.id, { showInTimeline: true, role: 'contributor' });
    await addAlbumAsset(t.ctx, album.id, june.id, alex.id);

    const alexBrowser = await signIn(t.app, alex.email);
    const buckets = await alexBrowser.call('timeline.buckets');
    expect(buckets.status).toBe(200);
    expect(buckets.data.buckets).toEqual([
      { key: '2024-10', count: 1 },
      { key: '2024-06', count: 1 },
    ]);

    const month = await alexBrowser.call('timeline.bucket', { params: { key: '2024-10' } });
    expect(month.data.assets.map((asset) => asset.id)).toEqual([october.id]);

    const samBrowser = await signIn(t.app, sam.email);
    const shared = await samBrowser.call('timeline.bucket', {
      params: { key: '2024-06' },
      query: { scope: 'library', withShared: 'true' },
    });
    expect(shared.data.assets.map((asset) => asset.id)).toEqual([june.id]);
    const alone = await samBrowser.call('timeline.bucket', {
      params: { key: '2024-06' },
      query: { scope: 'library', withShared: 'false' },
    });
    expect(alone.data.assets).toEqual([]);

    const favorites = await alexBrowser.call('assets.update', {
      body: { ids: [october.id], isFavorite: true },
    });
    expect(favorites.data.updated).toBe(1);
    const favoriteMonths = await alexBrowser.call('timeline.buckets', {
      query: { scope: 'favorites', withShared: 'true' },
    });
    expect(favoriteMonths.data.buckets).toEqual([{ key: '2024-10', count: 1 }]);
  });
});
