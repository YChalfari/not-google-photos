import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { invites, users } from '../src/db/schema';
import { TestClient } from './support/client';
import { createUser, signIn } from './support/factories';
import { createTestServer, type TestServer } from './support/server';

let t: TestServer;
let admin: TestClient;

beforeAll(async () => {
  t = await createTestServer({ env: { REMOTE_URL: 'https://photos.example.com' } });
  await createUser(t.ctx, { email: 'alex@example.com', name: 'Alex', role: 'admin' });
  await createUser(t.ctx, { email: 'sam@example.com', name: 'Sam' });
  admin = await signIn(t.app, 'alex@example.com');
});
afterAll(() => t.close());

describe('invites', () => {
  it('lets only admins create invites', async () => {
    const member = await signIn(t.app, 'sam@example.com');
    const result = await member.call('invites.create', { body: {} });
    expect(result.status).toBe(403);
    expect((await new TestClient(t.app).call('invites.create', { body: {} })).status).toBe(401);
  });

  it('creates a link, shows it once, and stores only a hash', async () => {
    const result = await admin.call('invites.create', { body: { name: 'Noa', expiresInDays: 3 } });
    expect(result.status).toBe(201);
    const { invite, token, path, url } = result.data;
    expect(token).toMatch(/^ngpi_/);
    expect(path).toBe(`/invite/${token}`);
    expect(url).toBe(`https://photos.example.com/invite/${token}`);
    expect(invite).toMatchObject({
      name: 'Noa',
      role: 'member',
      status: 'pending',
      createdBy: { name: 'Alex' },
    });

    const [row] = await t.ctx.db.select().from(invites).where(eq(invites.id, invite.id));
    expect(row?.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(row)).not.toContain(token);
    const expiresInMs = new Date(invite.expiresAt).getTime() - Date.now();
    expect(Math.round(expiresInMs / 86_400_000)).toBe(3);
  });

  it('refuses an invite for an email that already has an account', async () => {
    const result = await admin.call('invites.create', { body: { email: 'SAM@example.com' } });
    expect(result.status).toBe(409);
  });

  it('accepts an invite: new account with the invite role and quota, signed in', async () => {
    const created = await admin.call('invites.create', {
      body: { email: 'jo@example.com', role: 'admin', quotaBytes: 50_000_000_000 },
    });
    const guest = new TestClient(t.app);

    const lookup = await guest.call('invites.lookup', { body: { token: created.data.token } });
    expect(lookup.status).toBe(200);
    expect(lookup.data).toMatchObject({
      invite: { email: 'jo@example.com', role: 'admin', invitedBy: 'Alex' },
    });

    const wrongEmail = await guest.call('invites.accept', {
      body: {
        token: created.data.token,
        name: 'Jo',
        email: 'someone@example.com',
        password: 'jo-password-1',
      },
    });
    expect(wrongEmail.status).toBe(400);
    expect(wrongEmail.error?.message).toContain('jo@example.com');

    const accepted = await guest.call('invites.accept', {
      body: {
        token: created.data.token,
        name: 'Jo',
        email: 'Jo@Example.com',
        password: 'jo-password-1',
      },
    });
    expect(accepted.status).toBe(201);
    expect(accepted.data.user).toMatchObject({
      email: 'jo@example.com',
      name: 'Jo',
      role: 'admin',
    });
    expect((await guest.call('auth.me')).data.user.email).toBe('jo@example.com');

    const [jo] = await t.ctx.db.select().from(users).where(eq(users.email, 'jo@example.com'));
    expect(jo?.quotaBytes).toBe(50_000_000_000);

    const reused = await new TestClient(t.app).call('invites.accept', {
      body: {
        token: created.data.token,
        name: 'Jo 2',
        email: 'jo2@example.com',
        password: 'jo-password-2',
      },
    });
    expect(reused.status).toBe(410);
    expect(reused.error?.code).toBe('invite_invalid');
  });

  it('refuses an open invite for an email that already has an account', async () => {
    const created = await admin.call('invites.create', { body: {} });
    const result = await new TestClient(t.app).call('invites.accept', {
      body: {
        token: created.data.token,
        name: 'Sam again',
        email: 'sam@example.com',
        password: 'sam-password-2',
      },
    });
    expect(result.status).toBe(409);
    const [invite] = await t.ctx.db
      .select()
      .from(invites)
      .where(eq(invites.id, created.data.invite.id));
    expect(invite?.acceptedAt).toBeNull();
  });

  it('rejects revoked, expired, and made-up tokens', async () => {
    const revoked = await admin.call('invites.create', { body: {} });
    expect(
      (await admin.call('invites.revoke', { params: { id: revoked.data.invite.id } })).status,
    ).toBe(204);

    const expired = await admin.call('invites.create', { body: {} });
    await t.ctx.db
      .update(invites)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(invites.id, expired.data.invite.id));

    const guest = new TestClient(t.app);
    for (const token of [revoked.data.token, expired.data.token, 'ngpi_made-up-token-value']) {
      const lookup = await guest.call('invites.lookup', { body: { token } });
      expect(lookup.status).toBe(410);
      const accept = await guest.call('invites.accept', {
        body: { token, name: 'Nope', email: 'nope@example.com', password: 'nope-password' },
      });
      expect(accept.status).toBe(410);
    }
  });

  it('cannot revoke an accepted invite', async () => {
    const created = await admin.call('invites.create', { body: {} });
    await new TestClient(t.app).call('invites.accept', {
      body: {
        token: created.data.token,
        name: 'Kim',
        email: 'kim@example.com',
        password: 'kim-password',
      },
    });
    const result = await admin.call('invites.revoke', { params: { id: created.data.invite.id } });
    expect(result.status).toBe(409);
  });

  it('lists invites newest first with their status', async () => {
    const result = await admin.call('invites.list');
    expect(result.status).toBe(200);
    const statuses = result.data.invites.map((invite) => invite.status);
    expect(statuses).toEqual(expect.arrayContaining(['pending', 'accepted', 'revoked', 'expired']));
    const times = result.data.invites.map((invite) => new Date(invite.createdAt).getTime());
    expect([...times].sort((a, b) => b - a)).toEqual(times);
    const accepted = result.data.invites.find((invite) => invite.status === 'accepted');
    expect(accepted?.acceptedBy?.name).toBeTruthy();
  });
});
