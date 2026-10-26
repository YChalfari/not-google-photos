import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { sessions, users } from '../src/db/schema';
import { createRateLimits } from '../src/http/rate-limit';
import { TEST_ORIGIN, TestClient } from './support/client';
import { createUser, DEFAULT_PASSWORD, signIn } from './support/factories';
import { createTestServer, type TestServer } from './support/server';

let t: TestServer;
beforeAll(async () => {
  t = await createTestServer();
});
afterAll(() => t.close());

describe('first-run setup', () => {
  it('reports that setup is needed and refuses sign-in until it is done', async () => {
    const client = new TestClient(t.app);
    const info = await client.call('server.info');
    expect(info.status).toBe(200);
    expect(info.data.setupRequired).toBe(true);

    const login = await client.call('auth.login', {
      body: { email: 'alex@example.com', password: 'whatever' },
    });
    expect(login.status).toBe(409);
    expect(login.error?.code).toBe('setup_required');

    const me = await client.call('auth.me');
    expect(me.status).toBe(401);
  });

  it('creates the admin, renames the server, and signs in with an HttpOnly cookie', async () => {
    const client = new TestClient(t.app);
    const result = await client.call('setup.complete', {
      body: {
        name: 'Alex',
        email: '  Alex@Example.com ',
        password: DEFAULT_PASSWORD,
        serverName: 'Home Photos',
      },
    });
    expect(result.status).toBe(201);
    expect(result.data.user).toMatchObject({
      email: 'alex@example.com',
      name: 'Alex',
      role: 'admin',
    });
    expect(result.data.user).not.toHaveProperty('passwordHash');

    const cookie = result.res.headers.get('set-cookie') ?? '';
    expect(cookie).toMatch(/^ngp_session=ngps_/);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(cookie).not.toMatch(/Secure/i);

    const me = await client.call('auth.me');
    expect(me.status).toBe(200);
    expect(me.data).toMatchObject({
      via: 'session',
      deviceId: null,
      user: { email: 'alex@example.com' },
    });

    const info = await client.call('server.info');
    expect(info.data).toMatchObject({ setupRequired: false, name: 'Home Photos' });
  });

  it('only works once', async () => {
    const again = await new TestClient(t.app).call('setup.complete', {
      body: { name: 'Mallory', email: 'mallory@example.com', password: 'mallory-password' },
    });
    expect(again.status).toBe(409);
    expect(again.error?.code).toBe('setup_already_done');
    const [mallory] = await t.ctx.db
      .select()
      .from(users)
      .where(eq(users.email, 'mallory@example.com'));
    expect(mallory).toBeUndefined();
  });

  it('validates the request', async () => {
    const result = await new TestClient(t.app).call('setup.complete', {
      body: { name: '', email: 'not-an-email', password: 'short' },
    });
    expect(result.status).toBe(400);
    expect(result.error?.code).toBe('validation_failed');
    const issues = (result.error?.details as { issues: { path: string }[] }).issues.map(
      (issue) => issue.path,
    );
    expect(issues).toEqual(expect.arrayContaining(['name', 'email', 'password']));
  });
});

describe('sign in and sessions', () => {
  it('rejects wrong passwords and unknown emails the same way', async () => {
    const client = new TestClient(t.app);
    const wrong = await client.call('auth.login', {
      body: { email: 'alex@example.com', password: 'nope-nope' },
    });
    const unknown = await client.call('auth.login', {
      body: { email: 'who@example.com', password: 'nope-nope' },
    });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.error).toEqual(unknown.error);
    expect(wrong.error?.code).toBe('invalid_credentials');
  });

  it('signs in case-insensitively and records the login', async () => {
    const client = new TestClient(t.app);
    const result = await client.call('auth.login', {
      body: { email: 'ALEX@example.com', password: DEFAULT_PASSWORD },
    });
    expect(result.status).toBe(200);
    expect(client.cookie).toMatch(/^ngps_/);
    const [alex] = await t.ctx.db.select().from(users).where(eq(users.email, 'alex@example.com'));
    expect(alex?.lastLoginAt).toBeInstanceOf(Date);
  });

  it('stores only a hash of the session token', async () => {
    const client = await signIn(t.app, 'alex@example.com');
    const rows = await t.ctx.db.select().from(sessions);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.tokenHash).toMatch(/^[0-9a-f]{64}$/);
      expect(row.tokenHash).not.toBe(client.cookie);
    }
  });

  it('signs out and the cookie stops working', async () => {
    const client = await signIn(t.app, 'alex@example.com');
    const token = client.cookie;
    const logout = await client.call('auth.logout');
    expect(logout.status).toBe(204);
    expect(client.cookie).toBeUndefined();

    const stale = new TestClient(t.app);
    stale.cookie = token;
    expect((await stale.call('auth.me')).status).toBe(401);
  });

  it('ignores a garbage cookie and rejects a garbage bearer token', async () => {
    const client = new TestClient(t.app);
    client.cookie = 'ngps_not-a-real-token';
    expect((await client.call('auth.me')).status).toBe(401);

    const phone = new TestClient(t.app, 'ngpd_not-a-real-token');
    const result = await phone.call('auth.me');
    expect(result.status).toBe(401);
    expect(result.res.headers.get('www-authenticate')).toContain('invalid_token');
  });

  it('changes the password and signs out other browsers', async () => {
    await createUser(t.ctx, { email: 'pat@example.com' });
    const laptop = await signIn(t.app, 'pat@example.com');
    const desktop = await signIn(t.app, 'pat@example.com');

    const wrong = await laptop.call('auth.changePassword', {
      body: { currentPassword: 'not-my-password', newPassword: 'a brand new password' },
    });
    expect(wrong.status).toBe(401);
    expect(wrong.error?.code).toBe('invalid_credentials');

    const changed = await laptop.call('auth.changePassword', {
      body: { currentPassword: DEFAULT_PASSWORD, newPassword: 'a brand new password' },
    });
    expect(changed.status).toBe(204);
    expect((await laptop.call('auth.me')).status).toBe(200);
    expect((await desktop.call('auth.me')).status).toBe(401);
    await signIn(t.app, 'pat@example.com', 'a brand new password');
  });

  it('updates the profile and refuses an email that is taken', async () => {
    await createUser(t.ctx, { email: 'robin@example.com' });
    const robin = await signIn(t.app, 'robin@example.com');
    const renamed = await robin.call('me.update', { body: { name: 'Robin B.' } });
    expect(renamed.status).toBe(200);
    expect(renamed.data.user.name).toBe('Robin B.');

    const taken = await robin.call('me.update', { body: { email: 'ALEX@example.com' } });
    expect(taken.status).toBe(409);
    expect(taken.error?.code).toBe('conflict');
  });

  it('reports storage usage for the signed-in person', async () => {
    const robin = await signIn(t.app, 'robin@example.com');
    const usage = await robin.call('me.storage');
    expect(usage.status).toBe(200);
    expect(usage.data).toEqual({
      usedBytes: 0,
      quotaBytes: null,
      assetCount: 0,
      byType: { image: { count: 0, bytes: 0 }, video: { count: 0, bytes: 0 } },
    });
  });
});

describe('cross-site protection', () => {
  it('rejects cookie-authenticated writes from another origin', async () => {
    const client = await signIn(t.app, 'alex@example.com');
    const evil = await client.call('devices.createPairingCode', {
      headers: { origin: 'https://evil.example' },
    });
    expect(evil.status).toBe(403);
    const fetchSite = await client.call('devices.createPairingCode', {
      headers: { 'sec-fetch-site': 'cross-site' },
    });
    expect(fetchSite.status).toBe(403);
    const same = await client.call('devices.createPairingCode', {
      headers: { origin: TEST_ORIGIN },
    });
    expect(same.status).toBe(201);
  });

  it('rejects sign-in forms posted from another origin', async () => {
    const result = await new TestClient(t.app).call('auth.login', {
      body: { email: 'alex@example.com', password: DEFAULT_PASSWORD },
      headers: { origin: 'https://evil.example' },
    });
    expect(result.status).toBe(403);
  });

  it('requires a JSON content type for JSON bodies', async () => {
    const res = await new TestClient(t.app).fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: JSON.stringify({ email: 'alex@example.com', password: DEFAULT_PASSWORD }),
    });
    expect(res.status).toBe(415);
  });
});

describe('sign-in rate limit', () => {
  it('locks out an email from one address after 10 wrong passwords', async () => {
    const server = await createTestServer({ limits: createRateLimits({ ip: 1000 }) });
    try {
      await createUser(server.ctx, { email: 'sam@example.com' });
      const client = new TestClient(server.app);
      for (let i = 0; i < 10; i += 1) {
        const result = await client.call('auth.login', {
          body: { email: 'sam@example.com', password: 'guess-' + i },
        });
        expect(result.status).toBe(401);
      }
      const locked = await client.call('auth.login', {
        body: { email: 'sam@example.com', password: DEFAULT_PASSWORD },
      });
      expect(locked.status).toBe(429);
      expect(locked.error?.code).toBe('rate_limited');
      expect(Number(locked.res.headers.get('retry-after'))).toBeGreaterThan(0);
    } finally {
      await server.close();
    }
  });
});

describe('secure cookies behind a TLS proxy', () => {
  it('marks the cookie Secure when the proxy says the request was HTTPS', async () => {
    const server = await createTestServer({ env: { TRUST_PROXY: 'true' } });
    try {
      await createUser(server.ctx, { email: 'sam@example.com' });
      const result = await new TestClient(server.app).call('auth.login', {
        body: { email: 'sam@example.com', password: DEFAULT_PASSWORD },
        headers: {
          'x-forwarded-proto': 'https',
          'x-forwarded-host': 'photos.example.com',
          origin: 'https://photos.example.com',
        },
      });
      expect(result.status).toBe(200);
      expect(result.res.headers.get('set-cookie')).toMatch(/Secure/);
    } finally {
      await server.close();
    }
  });
});
