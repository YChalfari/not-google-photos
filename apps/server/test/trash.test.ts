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

describe('empty trash', () => {
  it('deletes the caller’s trash now and leaves everyone else’s', async () => {
    const alex = await createUser(t.ctx, { email: 'alex-trash@example.com', name: 'Alex' });
    const sam = await createUser(t.ctx, { email: 'sam-trash@example.com', name: 'Sam' });
    const gone = await insertAsset(t.ctx, alex.id, { trashed: true });
    const also = await insertAsset(t.ctx, alex.id, { trashed: true });
    const kept = await insertAsset(t.ctx, alex.id);
    const samTrash = await insertAsset(t.ctx, sam.id, { trashed: true });

    const browser = await signIn(t.app, alex.email);
    const emptied = await browser.call('assets.emptyTrash');
    expect(emptied.status, JSON.stringify(emptied.error)).toBe(200);
    expect(emptied.data.deleted).toBe(2);

    const left = await t.ctx.db
      .select({ id: assets.id })
      .from(assets)
      .where(eq(assets.ownerId, alex.id));
    expect(left.map((row) => row.id)).toEqual([kept.id]);
    const samLeft = await t.ctx.db
      .select({ id: assets.id })
      .from(assets)
      .where(eq(assets.id, samTrash.id));
    expect(samLeft).toHaveLength(1);
    expect([gone.id, also.id]).not.toContain(kept.id);

    const again = await browser.call('assets.emptyTrash');
    expect(again.data.deleted).toBe(0);
  });
});
