import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TestClient } from './support/client';
import { createUser, insertAsset, pairPhone, signIn } from './support/factories';
import { createTestServer, type TestServer } from './support/server';

let t: TestServer;
let admin: TestClient;
let alexId: string;
let samId: string;

beforeAll(async () => {
  t = await createTestServer({ env: { HOME_URL: 'http://192.168.1.20:4810' } });
  alexId = (await createUser(t.ctx, { email: 'alex@example.com', name: 'Alex', role: 'admin' })).id;
  samId = (await createUser(t.ctx, { email: 'sam@example.com', name: 'Sam' })).id;
  admin = await signIn(t.app, 'alex@example.com');
});
afterAll(() => t.close());

describe('admin: users', () => {
  it('lists everyone with storage and device counts', async () => {
    await insertAsset(t.ctx, samId, { bytes: Buffer.alloc(1000, 1) });
    await insertAsset(t.ctx, samId, { bytes: Buffer.alloc(3000, 2), type: 'video' });
    await pairPhone(await signIn(t.app, 'sam@example.com'));

    const result = await admin.call('admin.users.list');
    expect(result.status).toBe(200);
    const sam = result.data.users.find((user) => user.id === samId);
    expect(sam).toMatchObject({
      email: 'sam@example.com',
      status: 'active',
      deviceCount: 1,
      storage: { usedBytes: 4000, assetCount: 2, quotaBytes: null },
    });
    expect(sam).not.toHaveProperty('passwordHash');
  });

  it('is admin-only', async () => {
    const member = await signIn(t.app, 'sam@example.com');
    expect((await member.call('admin.users.list')).status).toBe(403);
    expect((await member.call('admin.server.get')).status).toBe(403);
  });

  it('sets a quota and a role', async () => {
    const result = await admin.call('admin.users.update', {
      params: { id: samId },
      body: { quotaBytes: 10_000_000, role: 'admin' },
    });
    expect(result.status).toBe(200);
    expect(result.data.user).toMatchObject({ role: 'admin', storage: { quotaBytes: 10_000_000 } });
    const back = await admin.call('admin.users.update', {
      params: { id: samId },
      body: { role: 'member' },
    });
    expect(back.data.user.role).toBe('member');
  });

  it('disabling signs the person out everywhere; enabling lets them back in', async () => {
    await createUser(t.ctx, { email: 'kim@example.com' });
    const kim = await signIn(t.app, 'kim@example.com');
    const { phone } = await pairPhone(kim);
    const kimId = (await kim.call('auth.me')).data.user.id;

    const disabled = await admin.call('admin.users.update', {
      params: { id: kimId },
      body: { disabled: true },
    });
    expect(disabled.data.user.status).toBe('disabled');
    expect((await kim.call('auth.me')).status).toBe(401);
    expect((await phone.call('auth.me')).status).toBe(401);

    const login = await new TestClient(t.app).call('auth.login', {
      body: { email: 'kim@example.com', password: 'correct horse battery' },
    });
    expect(login.status).toBe(403);
    expect(login.error?.code).toBe('account_disabled');

    await admin.call('admin.users.update', { params: { id: kimId }, body: { disabled: false } });
    await signIn(t.app, 'kim@example.com');
    expect((await phone.call('auth.me')).status).toBe(200);
  });

  it('never removes the last active admin', async () => {
    const demote = await admin.call('admin.users.update', {
      params: { id: alexId },
      body: { role: 'member' },
    });
    expect(demote.status).toBe(409);
    const disable = await admin.call('admin.users.update', {
      params: { id: alexId },
      body: { disabled: true },
    });
    expect(disable.status).toBe(409);

    await admin.call('admin.users.update', { params: { id: samId }, body: { role: 'admin' } });
    const nowAllowed = await admin.call('admin.users.update', {
      params: { id: alexId },
      body: { role: 'member' },
    });
    expect(nowAllowed.status).toBe(200);
    const sam = await signIn(t.app, 'sam@example.com');
    await sam.call('admin.users.update', { params: { id: alexId }, body: { role: 'admin' } });
  });

  it('returns 404 for an unknown user and 400 for an empty update', async () => {
    const unknown = await admin.call('admin.users.update', {
      params: { id: '00000000-0000-4000-8000-000000000000' },
      body: { name: 'Ghost' },
    });
    expect(unknown.status).toBe(404);
    const empty = await admin.call('admin.users.update', { params: { id: samId }, body: {} });
    expect(empty.status).toBe(400);
  });
});

describe('admin: server settings', () => {
  it('shows addresses, defaults from the environment, and the library status', async () => {
    const result = await admin.call('admin.server.get');
    expect(result.status).toBe(200);
    expect(result.data).toMatchObject({
      homeUrl: null,
      remoteUrl: null,
      defaults: { homeUrl: 'http://192.168.1.20:4810', remoteUrl: null },
      library: { state: 'ok', path: t.libraryDir },
    });
  });

  it('overrides addresses and falls back to the environment with null', async () => {
    const updated = await admin.call('admin.server.update', {
      body: {
        name: 'Family Photos',
        homeUrl: 'http://macbook.local:4810/',
        remoteUrl: 'https://mac.tail1234.ts.net',
      },
    });
    expect(updated.status).toBe(200);
    expect(updated.data).toMatchObject({
      name: 'Family Photos',
      homeUrl: 'http://macbook.local:4810',
      remoteUrl: 'https://mac.tail1234.ts.net',
    });
    const info = await new TestClient(t.app).call('server.info');
    expect(info.data).toMatchObject({
      homeUrl: 'http://macbook.local:4810',
      remoteUrl: 'https://mac.tail1234.ts.net',
    });

    await admin.call('admin.server.update', { body: { homeUrl: null, remoteUrl: null } });
    const fallback = await new TestClient(t.app).call('server.info');
    expect(fallback.data).toMatchObject({ homeUrl: 'http://192.168.1.20:4810', remoteUrl: null });
  });

  it('rejects addresses that are not http(s) URLs', async () => {
    const result = await admin.call('admin.server.update', {
      body: { homeUrl: 'ftp://example.com' },
    });
    expect(result.status).toBe(400);
  });
});

describe('people directory', () => {
  it('lists other active people for sharing pickers', async () => {
    const sam = await signIn(t.app, 'sam@example.com');
    const result = await sam.call('users.directory');
    expect(result.status).toBe(200);
    const names = result.data.users.map((user) => user.name);
    expect(names).toContain('Alex');
    expect(names).not.toContain('Sam');
    const first = result.data.users[0];
    expect(typeof first?.id).toBe('string');
    expect(typeof first?.name).toBe('string');
  });
});
