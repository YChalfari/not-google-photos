import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createUser, signIn } from './support/factories';
import { TestClient } from './support/client';
import { createTestServer, type TestServer } from './support/server';

let webRoot: string;
let t: TestServer;

beforeAll(async () => {
  webRoot = await mkdtemp(path.join(os.tmpdir(), 'ngp-web-'));
  await mkdir(path.join(webRoot, 'assets'));
  await writeFile(
    path.join(webRoot, 'index.html'),
    '<!doctype html><title>NGP</title><div id="root">Library</div>',
  );
  await writeFile(path.join(webRoot, 'assets', 'app.js'), 'console.log("library")');
  t = await createTestServer({ env: { WEB_DIST_DIR: webRoot } });
});

afterAll(async () => {
  await t.close();
  await rm(webRoot, { recursive: true, force: true });
});

describe('health, identity, and the contract surface', () => {
  it('reports a healthy server before anyone has signed up', async () => {
    const client = new TestClient(t.app);
    const health = await client.call('server.health');
    expect(health.status).toBe(200);
    expect(health.data.status).toBe('ok');
    expect(health.data.checks).toMatchObject({
      database: 'ok',
      library: 'ok',
      ml: 'disabled',
      jobs: 'disabled',
    });
    expect(health.data.version).toBe(t.ctx.version);

    const ping = await client.call('server.ping');
    expect(ping.status).toBe(200);
    expect(ping.data).toMatchObject({ ok: true, serverId: t.ctx.serverId });

    const info = await client.call('server.info');
    expect(info.data.setupRequired).toBe(true);

    const missing = await client.fetch('/api/does-not-exist');
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ error: { code: 'not_found' } });
  });

  it('publishes OpenAPI and marks later pieces as not implemented', async () => {
    const res = await new TestClient(t.app).fetch('/api/openapi.json');
    expect(res.status).toBe(200);
    const doc = (await res.json()) as {
      openapi: string;
      info: { title: string; version: string };
      paths: Record<string, Record<string, { operationId: string; 'x-implemented': boolean }>>;
    };
    expect(doc.openapi).toBe('3.1.0');
    expect(doc.info).toMatchObject({ title: 'Not Google Photos API', version: t.ctx.version });
    expect(doc.paths['/api/health']?.get).toMatchObject({
      operationId: 'server.health',
      'x-implemented': true,
    });
    expect(doc.paths['/api/timeline/buckets']?.get).toMatchObject({
      operationId: 'timeline.buckets',
      'x-implemented': false,
    });
    expect(doc.paths['/api/assets']?.post?.['x-implemented']).toBe(false);
  });

  it('answers unimplemented endpoints with 501 after the auth check', async () => {
    const anon = await new TestClient(t.app).call('timeline.buckets');
    expect(anon.status).toBe(401);

    await createUser(t.ctx, { email: 'alex@example.com', role: 'admin' });
    const client = await signIn(t.app, 'alex@example.com');
    const timeline = await client.call('timeline.buckets');
    expect(timeline.status).toBe(501);
    expect(timeline.error?.code).toBe('not_implemented');

    const people = await client.call('people.list');
    expect(people.status).toBe(501);
  });

  it('serves the web app, its assets, and client-side routes', async () => {
    const client = new TestClient(t.app);
    const home = await client.fetch('/');
    expect(home.status).toBe(200);
    expect(home.headers.get('content-type')).toContain('text/html');
    expect(home.headers.get('content-security-policy')).toContain("default-src 'self'");
    expect(await home.text()).toContain('Library');

    const route = await client.fetch('/settings');
    expect(route.status).toBe(200);
    expect(await route.text()).toContain('id="root"');

    const asset = await client.fetch('/assets/app.js');
    expect(asset.status).toBe(200);
    expect(asset.headers.get('cache-control')).toContain('immutable');
    expect(await asset.text()).toContain('library');

    const missing = await client.fetch('/assets/missing.js');
    expect(missing.status).toBe(404);
  });
});
