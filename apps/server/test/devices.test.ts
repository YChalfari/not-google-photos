import { parsePairingUri } from '@ngp/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { devices, pairingCodes } from '../src/db/schema';
import { TestClient } from './support/client';
import { createUser, DEFAULT_PASSWORD, pairPhone, signIn } from './support/factories';
import { createTestServer, type TestServer } from './support/server';

let t: TestServer;
let alex: TestClient;

const pixel = {
  name: 'Pixel 9',
  platform: 'android',
  model: 'Google Pixel 9',
  osVersion: '16',
  appVersion: '0.1.0',
} as const;

beforeAll(async () => {
  t = await createTestServer({
    env: { HOME_URL: 'http://192.168.1.20:4810', SERVER_NAME: 'Home Photos' },
  });
  await createUser(t.ctx, { email: 'alex@example.com', name: 'Alex', role: 'admin' });
  await createUser(t.ctx, { email: 'sam@example.com', name: 'Sam' });
  alex = await signIn(t.app, 'alex@example.com');
});
afterAll(() => t.close());

describe('pairing with a QR code', () => {
  it('creates a one-time code and a QR payload the phone can parse', async () => {
    const result = await alex.call('devices.createPairingCode');
    expect(result.status).toBe(201);
    const { code, payload, uri, expiresAt } = result.data;
    expect(code).toMatch(/^[0-9A-Z]{5}-[0-9A-Z]{5}$/);
    expect(payload).toMatchObject({
      version: 1,
      serverId: t.ctx.serverId,
      serverName: 'Home Photos',
      homeUrl: 'http://192.168.1.20:4810',
      remoteUrl: null,
      code: code.replace('-', ''),
    });
    const ttl = new Date(expiresAt).getTime() - Date.now();
    expect(ttl).toBeGreaterThan(9 * 60_000);
    expect(ttl).toBeLessThanOrEqual(10 * 60_000);

    const parsed = parsePairingUri(uri);
    expect(parsed).toMatchObject({
      serverId: t.ctx.serverId,
      homeUrl: payload.homeUrl,
      code: payload.code,
    });

    const [row] = await t.ctx.db
      .select()
      .from(pairingCodes)
      .where(eq(pairingCodes.id, result.data.id));
    expect(row?.codeHash).not.toContain(payload.code);
  });

  it('exchanges the code for a device token once, and the browser sees it used', async () => {
    const created = await alex.call('devices.createPairingCode');
    const status = await alex.call('devices.pairingCodeStatus', {
      params: { id: created.data.id },
    });
    expect(status.data).toMatchObject({ status: 'pending', device: null });

    const phone = new TestClient(t.app);
    // Typed by hand: lower case, a space instead of the dash, and O for 0 all work.
    const typed = created.data.code.toLowerCase().replace('-', ' ').replace(/0/g, 'o');
    const paired = await phone.call('devices.pair', {
      body: { method: 'code', code: typed, device: pixel },
    });
    expect(paired.status, JSON.stringify(paired.error)).toBe(201);
    expect(paired.data.deviceToken).toMatch(/^ngpd_/);
    expect(paired.data.user.email).toBe('alex@example.com');
    expect(paired.data.server).toEqual({
      serverId: t.ctx.serverId,
      name: 'Home Photos',
      homeUrl: 'http://192.168.1.20:4810',
      remoteUrl: null,
    });

    const again = await phone.call('devices.pair', {
      body: { method: 'code', code: created.data.code, device: pixel },
    });
    expect(again.status).toBe(400);
    expect(again.error?.code).toBe('pairing_code_invalid');

    const used = await alex.call('devices.pairingCodeStatus', { params: { id: created.data.id } });
    expect(used.data.status).toBe('used');
    expect(used.data.device).toMatchObject({
      id: paired.data.deviceId,
      name: 'Pixel 9',
      platform: 'android',
    });

    const [row] = await t.ctx.db.select().from(devices).where(eq(devices.id, paired.data.deviceId));
    expect(row?.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(row?.tokenHash).not.toBe(paired.data.deviceToken);
  });

  it('rejects expired and made-up codes', async () => {
    const created = await alex.call('devices.createPairingCode');
    await t.ctx.db
      .update(pairingCodes)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(pairingCodes.id, created.data.id));
    const phone = new TestClient(t.app);
    const expired = await phone.call('devices.pair', {
      body: { method: 'code', code: created.data.code, device: pixel },
    });
    expect(expired.status).toBe(400);
    const status = await alex.call('devices.pairingCodeStatus', {
      params: { id: created.data.id },
    });
    expect(status.data.status).toBe('expired');

    const madeUp = await phone.call('devices.pair', {
      body: { method: 'code', code: 'ABCDE-12345', device: pixel },
    });
    expect(madeUp.error?.code).toBe('pairing_code_invalid');
    const malformed = await phone.call('devices.pair', {
      body: { method: 'code', code: 'abc', device: pixel },
    });
    expect(malformed.status).toBe(400);
    expect(malformed.error?.code).toBe('validation_failed');
  });

  it("doesn't show another person's pairing codes", async () => {
    const created = await alex.call('devices.createPairingCode');
    const sam = await signIn(t.app, 'sam@example.com');
    const result = await sam.call('devices.pairingCodeStatus', { params: { id: created.data.id } });
    expect(result.status).toBe(404);
  });

  it('works from the phone app origin (CORS, no cookies)', async () => {
    const created = await alex.call('devices.createPairingCode');
    const result = await new TestClient(t.app).call('devices.pair', {
      body: { method: 'code', code: created.data.code, device: pixel },
      headers: { origin: 'https://localhost' },
    });
    expect(result.status).toBe(201);
    expect(result.res.headers.get('access-control-allow-origin')).toBe('https://localhost');
    expect(result.res.headers.get('access-control-allow-credentials')).toBeNull();
  });
});

describe('pairing with email and password', () => {
  it('signs a phone in without a QR code', async () => {
    const result = await new TestClient(t.app).call('devices.pair', {
      body: {
        method: 'password',
        email: 'SAM@example.com',
        password: DEFAULT_PASSWORD,
        device: pixel,
      },
    });
    expect(result.status).toBe(201);
    expect(result.data.user.email).toBe('sam@example.com');
  });

  it('rejects a wrong password', async () => {
    const result = await new TestClient(t.app).call('devices.pair', {
      body: {
        method: 'password',
        email: 'sam@example.com',
        password: 'wrong-password',
        device: pixel,
      },
    });
    expect(result.status).toBe(401);
    expect(result.error?.code).toBe('invalid_credentials');
  });
});

describe('device tokens', () => {
  it('authenticates the phone as its owner', async () => {
    const { phone, deviceId } = await pairPhone(alex, 'Alex phone');
    const me = await phone.call('auth.me');
    expect(me.data).toMatchObject({ via: 'device', deviceId, user: { email: 'alex@example.com' } });

    const list = await phone.call('devices.list');
    const current = list.data.devices.find((device) => device.id === deviceId);
    expect(current?.isCurrent).toBe(true);
    expect(current?.lastSeenAt).not.toBeNull();
    expect(list.data.devices.filter((device) => device.isCurrent)).toHaveLength(1);
  });

  it('skips the same-origin check (no cookies are involved)', async () => {
    const { phone } = await pairPhone(alex, 'Alex tablet');
    const result = await phone.call('devices.createPairingCode', {
      headers: { origin: 'https://localhost' },
    });
    expect(result.status).toBe(201);
  });

  it('renames and revokes; a revoked token stops working at once', async () => {
    const { phone, deviceId } = await pairPhone(alex, 'Old phone');
    const renamed = await alex.call('devices.update', {
      params: { id: deviceId },
      body: { name: 'Grandma phone' },
    });
    expect(renamed.data.device.name).toBe('Grandma phone');

    expect((await alex.call('devices.revoke', { params: { id: deviceId } })).status).toBe(204);
    expect((await phone.call('auth.me')).status).toBe(401);
    const list = await alex.call('devices.list');
    expect(list.data.devices.map((device) => device.id)).not.toContain(deviceId);
    expect((await alex.call('devices.revoke', { params: { id: deviceId } })).status).toBe(404);
  });

  it("can't rename or revoke someone else's device", async () => {
    const sam = await signIn(t.app, 'sam@example.com');
    const { phone, deviceId } = await pairPhone(sam, 'Sam phone');
    expect(
      (await alex.call('devices.update', { params: { id: deviceId }, body: { name: 'Mine now' } }))
        .status,
    ).toBe(404);
    expect((await alex.call('devices.revoke', { params: { id: deviceId } })).status).toBe(404);
    expect((await phone.call('auth.me')).status).toBe(200);
    const alexDevices = await alex.call('devices.list');
    expect(alexDevices.data.devices.map((device) => device.id)).not.toContain(deviceId);
  });

  it('signing out on the phone revokes its token', async () => {
    const { phone } = await pairPhone(alex, 'Temporary phone');
    expect((await phone.call('auth.logout')).status).toBe(204);
    expect((await phone.call('auth.me')).status).toBe(401);
  });
});
