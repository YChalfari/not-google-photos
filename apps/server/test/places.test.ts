import { eq } from 'drizzle-orm';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assets } from '../src/db/schema';
import { nearestPlace } from '../src/places/geocode';
import { fillMissingPlaces } from '../src/places/backfill';
import { processAsset } from '../src/media/derivatives';
import { createUser, insertAsset, signIn } from './support/factories';
import { createTestServer, type TestServer } from './support/server';

let t: TestServer;

beforeAll(async () => {
  t = await createTestServer();
});
afterAll(() => t.close());

describe('places', () => {
  it('names a nearby city and leaves open ocean unnamed', () => {
    const telAviv = nearestPlace(32.08, 34.78);
    expect(telAviv).toMatchObject({ city: 'Tel Aviv', country: 'Israel', countryCode: 'IL' });
    expect(nearestPlace(0, -40)).toBeNull();
  });

  it('fills city names from stored coordinates and leaves an existing city', async () => {
    const user = await createUser(t.ctx, { email: 'places@example.com', name: 'Places' });
    const jpeg = await sharp({
      create: { width: 16, height: 16, channels: 3, background: { r: 20, g: 80, b: 40 } },
    })
      .jpeg()
      .toBuffer();
    const other = await sharp({
      create: { width: 16, height: 16, channels: 3, background: { r: 200, g: 20, b: 20 } },
    })
      .jpeg()
      .toBuffer();
    const photo = await insertAsset(t.ctx, user.id, { bytes: jpeg });
    const named = await insertAsset(t.ctx, user.id, { bytes: other });
    const ocean = await insertAsset(t.ctx, user.id);
    await t.ctx.db
      .update(assets)
      .set({ latitude: 32.08, longitude: 34.78 })
      .where(eq(assets.id, photo.id));
    await t.ctx.db
      .update(assets)
      .set({ latitude: 32.08, longitude: 34.78, city: 'Seed City' })
      .where(eq(assets.id, named.id));
    await t.ctx.db
      .update(assets)
      .set({ latitude: 0, longitude: -40 })
      .where(eq(assets.id, ocean.id));

    await processAsset(t.ctx, photo.id);
    const filled = await t.ctx.db.select().from(assets).where(eq(assets.id, photo.id));
    expect(filled[0]?.city).toBe('Tel Aviv');
    expect(filled[0]?.country).toBe('Israel');

    const batch = await fillMissingPlaces(t.ctx.db, 50);
    expect(batch.filled).toBe(0);
    const kept = await t.ctx.db.select().from(assets).where(eq(assets.id, named.id));
    expect(kept[0]?.city).toBe('Seed City');
    const unnamed = await t.ctx.db.select().from(assets).where(eq(assets.id, ocean.id));
    expect(unnamed[0]?.city).toBeNull();
    expect(unnamed[0]?.processingSteps).toMatchObject({ places: 'none' });

    const browser = await signIn(t.app, user.email);
    const map = await browser.call('map.points');
    expect(map.status).toBe(200);
    expect(map.data.points.map((point) => point.id).sort()).toEqual(
      [named.id, ocean.id, photo.id].sort(),
    );
  });
});
