import { randomBytes, randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LIBRARY_MARKER_FILE, LibraryGuard } from '../src/storage/library-guard';
import { LocalStorageProvider } from '../src/storage/local';
import { LibraryUnavailableError } from '../src/storage/provider';
import { TestClient } from './support/client';
import { createUser, signIn } from './support/factories';
import { createTestServer, type TestServer } from './support/server';

let base: string;
beforeAll(async () => {
  base = await mkdtemp(path.join(os.tmpdir(), 'ngp-guard-'));
});
afterAll(() => rm(base, { recursive: true, force: true }));

function makeGuard(
  dir: string,
  options: { initialized?: boolean; minFreeBytes?: number; serverId?: string } = {},
) {
  const state = { initialized: options.initialized ?? false, marked: 0 };
  const guard = new LibraryGuard({
    dir,
    serverId: options.serverId ?? 'server-a',
    minFreeBytes: options.minFreeBytes ?? 0,
    isInitialized: () => Promise.resolve(state.initialized),
    markInitialized: () => {
      state.initialized = true;
      state.marked += 1;
      return Promise.resolve();
    },
    cacheMs: 0,
  });
  return { guard, state };
}

describe('LibraryGuard', () => {
  it('claims an empty folder on first run with a marker file', async () => {
    const dir = path.join(base, 'first-run');
    await mkdir(dir);
    const { guard, state } = makeGuard(dir);
    const status = await guard.status();
    expect(status.state).toBe('ok');
    expect(status.freeBytes).toBeGreaterThan(0);
    expect(state).toEqual({ initialized: true, marked: 1 });
    const marker = JSON.parse(await readFile(path.join(dir, LIBRARY_MARKER_FILE), 'utf8')) as {
      serverId: string;
    };
    expect(marker.serverId).toBe('server-a');
  });

  it('treats a missing folder as an unplugged drive and never creates it', async () => {
    const dir = path.join(base, 'Volumes', 'Photos', 'library');
    const { guard } = makeGuard(dir, { initialized: true });
    const status = await guard.status();
    expect(status.state).toBe('missing');
    expect(status.message).toContain('connect the drive');
    await expect(guard.assertWritable()).rejects.toBeInstanceOf(LibraryUnavailableError);
    await expect(readdir(path.join(base, 'Volumes'))).rejects.toThrow();
  });

  it('treats a folder without the marker as missing once a library was set up', async () => {
    // e.g. the drive is unplugged and macOS left an empty mount point behind.
    const dir = path.join(base, 'empty-mount-point');
    await mkdir(dir);
    const { guard } = makeGuard(dir, { initialized: true });
    expect((await guard.status()).state).toBe('missing');
    expect(await readdir(dir)).toEqual([]);
  });

  it("refuses another server's library", async () => {
    const dir = path.join(base, 'other-server');
    await mkdir(dir);
    await makeGuard(dir, { serverId: 'server-b' }).guard.status();
    const { guard } = makeGuard(dir, { serverId: 'server-a' });
    const status = await guard.status();
    expect(status.state).toBe('mismatch');
    expect(status.message).toContain('server-b');
  });

  it('pauses uploads when the drive is almost full', async () => {
    const dir = path.join(base, 'full');
    await mkdir(dir);
    const { guard } = makeGuard(dir, { minFreeBytes: Number.MAX_SAFE_INTEGER });
    const status = await guard.status();
    expect(status.state).toBe('low_space');
    expect(status.message).toContain('almost full');
  });

  it.skipIf(process.getuid?.() === 0)('reports a read-only folder', async () => {
    const dir = path.join(base, 'read-only');
    await mkdir(dir);
    await makeGuard(dir).guard.status();
    await chmod(dir, 0o555);
    try {
      expect((await makeGuard(dir, { initialized: true }).guard.status()).state).toBe(
        'not_writable',
      );
    } finally {
      await chmod(dir, 0o755);
    }
  });

  it('makes the storage provider refuse writes, leaving no files behind', async () => {
    const dir = path.join(base, 'unplugged');
    await mkdir(dir);
    const { guard } = makeGuard(dir, { initialized: true });
    const storage = new LocalStorageProvider(dir, guard);
    await expect(storage.put(randomBytes(100))).rejects.toBeInstanceOf(LibraryUnavailableError);
    expect(await readdir(dir)).toEqual([]);
  });
});

describe('library guard in the running server', () => {
  let t: TestServer;
  beforeAll(async () => {
    t = await createTestServer();
    await createUser(t.ctx, { email: 'alex@example.com', role: 'admin' });
  });
  afterAll(() => t.close());

  it('claims the library on start, then reports the drive missing when the marker disappears', async () => {
    expect((await t.ctx.library.status({ fresh: true })).state).toBe('ok');
    const health = await new TestClient(t.app).call('server.health');
    expect(health.data).toMatchObject({
      status: 'ok',
      checks: { library: 'ok', database: 'ok', jobs: 'disabled' },
    });

    await rm(path.join(t.libraryDir, LIBRARY_MARKER_FILE));
    expect((await t.ctx.library.status({ fresh: true })).state).toBe('missing');

    const degraded = await new TestClient(t.app).call('server.health');
    expect(degraded.status).toBe(200);
    expect(degraded.data).toMatchObject({ status: 'degraded', checks: { library: 'missing' } });

    await expect(t.ctx.files.ingest(randomBytes(100))).rejects.toBeInstanceOf(
      LibraryUnavailableError,
    );

    const admin = await signIn(t.app, 'alex@example.com');
    const settings = await admin.call('admin.server.get');
    expect(settings.data.library.state).toBe('missing');

    await writeFile(
      path.join(t.libraryDir, LIBRARY_MARKER_FILE),
      JSON.stringify({
        app: 'not-google-photos',
        serverId: t.ctx.serverId,
        createdAt: new Date().toISOString(),
      }),
    );
    expect((await t.ctx.library.status({ fresh: true })).state).toBe('ok');
    await expect(t.ctx.files.ingest(randomBytes(100))).resolves.toMatchObject({ created: true });
  });

  it('refuses to start writing into a library that belongs to another server', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ngp-foreign-'));
    await writeFile(
      path.join(dir, LIBRARY_MARKER_FILE),
      JSON.stringify({
        app: 'not-google-photos',
        serverId: randomUUID(),
        createdAt: new Date().toISOString(),
      }),
    );
    const other = await createTestServer({ libraryDir: dir });
    try {
      expect((await other.ctx.library.status()).state).toBe('mismatch');
    } finally {
      await other.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
