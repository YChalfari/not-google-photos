import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { faces, people } from '../src/db/schema';
import { createUser, insertAsset, insertFace, insertPerson, signIn } from './support/factories';
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
      'x-implemented': true,
    });
    expect(doc.paths['/api/assets']?.post?.['x-implemented']).toBe(true);
    expect(doc.paths['/api/people']?.get?.['x-implemented']).toBe(true);
    expect(doc.paths['/api/search']?.get?.['x-implemented']).toBe(true);
    expect(doc.paths['/api/albums']?.get?.['x-implemented']).toBe(true);
    expect(doc.paths['/api/map']?.get?.['x-implemented']).toBe(true);
  });

  it('requires a session, then answers the library endpoints', async () => {
    const anon = await new TestClient(t.app).call('timeline.buckets');
    expect(anon.status).toBe(401);

    await createUser(t.ctx, { email: 'alex@example.com', role: 'admin' });
    const client = await signIn(t.app, 'alex@example.com');
    const albums = await client.call('albums.list');
    expect(albums.status).toBe(200);
    expect(albums.data.albums).toEqual([]);

    const people = await client.call('people.list');
    expect(people.status).toBe(200);
    expect(people.data.people).toEqual([]);

    const search = await client.call('search.query', { query: { q: 'cake' } });
    expect(search.status).toBe(200);
    expect(search.data.items).toEqual([]);
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

describe('merging people', () => {
  it('keeps the main photo and can combine several people into a named one', async () => {
    const user = await createUser(t.ctx, { email: 'merge@example.com' });
    const client = await signIn(t.app, user.email);
    const kept = await insertAsset(t.ctx, user.id, { filename: 'kept.jpg' });
    const other = await insertAsset(t.ctx, user.id, { filename: 'other.jpg' });
    const third = await insertAsset(t.ctx, user.id, { filename: 'third.jpg' });
    const stranger = await insertAsset(t.ctx, user.id, { filename: 'stranger.jpg' });
    const maya = await insertPerson(t.ctx, user.id, 'Maya');
    const duplicate = await insertPerson(t.ctx, user.id, null);
    const another = await insertPerson(t.ctx, user.id, null);
    const mayaFace = await insertFace(t.ctx, {
      assetId: kept.id,
      ownerId: user.id,
      personId: maya.id,
    });
    const duplicateFace = await insertFace(t.ctx, {
      assetId: other.id,
      ownerId: user.id,
      personId: duplicate.id,
    });
    await insertFace(t.ctx, { assetId: third.id, ownerId: user.id, personId: another.id });
    await t.ctx.db.update(faces).set({ quality: 0.2 }).where(eq(faces.id, mayaFace.id));
    await t.ctx.db.update(faces).set({ quality: 0.99 }).where(eq(faces.id, duplicateFace.id));
    await t.ctx.db.update(people).set({ coverFaceId: mayaFace.id }).where(eq(people.id, maya.id));
    await t.ctx.db
      .update(people)
      .set({ coverFaceId: duplicateFace.id })
      .where(eq(people.id, duplicate.id));

    const merged = await client.call('people.merge', {
      params: { id: maya.id },
      body: { sourcePersonIds: [duplicate.id, another.id] },
    });
    expect(merged.status).toBe(200);
    expect(merged.data.person).toMatchObject({
      id: maya.id,
      name: 'Maya',
      faceCount: 3,
      coverAssetId: kept.id,
    });

    const gone = await client.call('people.get', { params: { id: duplicate.id } });
    expect(gone.status).toBe(404);

    const changed = await client.call('people.update', {
      params: { id: maya.id },
      body: { coverAssetId: other.id },
    });
    expect(changed.status).toBe(200);
    expect(changed.data.person.coverAssetId).toBe(other.id);

    const missing = await client.call('people.update', {
      params: { id: maya.id },
      body: { coverAssetId: stranger.id },
    });
    expect(missing.status).toBe(404);
  });
});
