import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assets, people } from '../src/db/schema';
import {
  calendarDate,
  memorySubtitle,
  spreadAcrossYears,
  type DatedAsset,
} from '../src/memories/on-this-day';
import { createUser, insertAsset, insertFace, insertPerson, signIn } from './support/factories';
import { createTestServer, type TestServer } from './support/server';

let t: TestServer;

beforeAll(async () => {
  t = await createTestServer();
});
afterAll(() => t.close());

async function onDate(ownerId: string, localDate: string) {
  const asset = await insertAsset(t.ctx, ownerId, {
    capturedAt: new Date(`${localDate}T12:00:00Z`),
  });
  await t.ctx.db.update(assets).set({ localDate }).where(eq(assets.id, asset.id));
  return asset;
}

describe('on this day', () => {
  it('spreads a capped set across years', () => {
    const rows: DatedAsset[] = [];
    for (let year = 2000; year < 2003; year += 1) {
      for (let index = 0; index < 5; index += 1) rows.push({ id: `${year}-${index}`, year });
    }
    const picked = spreadAcrossYears(rows, 4);
    expect(picked.map((row) => row.id)).toEqual(['2002-0', '2001-0', '2000-0', '2002-1']);
    expect(memorySubtitle([2019], 2026)).toBe('7 years ago');
    expect(memorySubtitle([2018, 2024], 2026)).toBe('2018 – 2024');
  });

  it('keeps earlier years on this day, hides dismissed memories, and skips hidden people', async () => {
    const alex = await createUser(t.ctx, { email: 'alex-memory@example.com' });
    const sam = await createUser(t.ctx, { email: 'sam-memory@example.com' });
    const alexBrowser = await signIn(t.app, alex.email);
    const samBrowser = await signIn(t.app, sam.email);

    await onDate(alex.id, '2019-10-28');
    await onDate(alex.id, '2020-01-02');
    await onDate(alex.id, '2026-10-28');
    await onDate(alex.id, '2018-10-28').then(async (asset) => {
      await t.ctx.db.update(assets).set({ trashedAt: new Date() }).where(eq(assets.id, asset.id));
    });

    const listed = await alexBrowser.call('memories.list', {
      query: { from: '2026-10-28', to: '2026-10-28' },
    });
    expect(listed.status, JSON.stringify(listed.error)).toBe(200);
    expect(listed.data.memories).toHaveLength(1);
    const memory = listed.data.memories[0]!;
    expect(memory.title).toBe('On this day');
    expect(memory.subtitle).toBe('7 years ago');
    expect(memory.assetCount).toBe(1);
    expect(memory.dismissedAt).toBeNull();

    const again = await alexBrowser.call('memories.list', {
      query: { from: '2026-10-28', to: '2026-10-28' },
    });
    expect(again.data.memories[0]?.id).toBe(memory.id);

    const detail = await alexBrowser.call('memories.get', { params: { id: memory.id } });
    expect(detail.status).toBe(200);
    expect(detail.data.memory.assets).toHaveLength(1);
    expect(detail.data.memory.assets[0]?.localDate).toBe('2019-10-28');

    const other = await samBrowser.call('memories.get', { params: { id: memory.id } });
    expect(other.status).toBe(404);

    const today = calendarDate();
    const past = `${Number(today.slice(0, 4)) - 4}${today.slice(4)}`;
    await onDate(sam.id, past);
    const upcoming = await samBrowser.call('memories.upcoming', { query: { days: 1 } });
    expect(upcoming.status, JSON.stringify(upcoming.error)).toBe(200);
    expect(upcoming.data.memories.some((item) => item.date === today && item.assetCount > 0)).toBe(
      true,
    );

    const dismissed = await alexBrowser.call('memories.update', {
      params: { id: memory.id },
      body: { dismissed: true },
    });
    expect(dismissed.status).toBe(200);
    expect(dismissed.data.memory.dismissedAt).not.toBeNull();
    const hidden = await alexBrowser.call('memories.list', {
      query: { from: '2026-10-28', to: '2026-10-28' },
    });
    expect(hidden.data.memories).toEqual([]);

    const quiet = await insertPerson(t.ctx, alex.id, 'Quiet');
    await t.ctx.db.update(people).set({ hideFromMemories: true }).where(eq(people.id, quiet.id));
    const withFace = await onDate(alex.id, '2017-03-04');
    await insertFace(t.ctx, { assetId: withFace.id, ownerId: alex.id, personId: quiet.id });
    const plain = await onDate(alex.id, '2016-03-04');
    const day = await alexBrowser.call('memories.list', {
      query: { from: '2026-03-04', to: '2026-03-04' },
    });
    expect(day.data.memories).toHaveLength(1);
    expect(day.data.memories[0]?.assetCount).toBe(1);
    const opened = await alexBrowser.call('memories.get', {
      params: { id: day.data.memories[0]!.id },
    });
    expect(opened.data.memory.assets.map((asset) => asset.id)).toEqual([plain.id]);
  });
});
