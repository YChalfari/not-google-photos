import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assetFiles } from '../src/db/schema';
import { ensurePlayback, shouldTranscode } from '../src/media/playback';
import { createUser, insertAsset } from './support/factories';
import { createTestServer, type TestServer } from './support/server';

const ffmpeg = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' });
const hasFfmpeg = ffmpeg.status === 0;

let t: TestServer;

beforeAll(async () => {
  t = await createTestServer();
});
afterAll(() => t.close());

describe('playback', () => {
  it('skips a browser-playable MP4 and transcodes everything else', () => {
    expect(shouldTranscode({ mimeType: 'video/mp4', videoCodec: 'h264', audioCodec: 'aac' })).toBe(
      false,
    );
    expect(shouldTranscode({ mimeType: 'video/mp4', videoCodec: 'h264', audioCodec: null })).toBe(
      false,
    );
    expect(shouldTranscode({ mimeType: 'video/mp4', videoCodec: 'hevc', audioCodec: 'aac' })).toBe(
      true,
    );
    expect(
      shouldTranscode({ mimeType: 'video/quicktime', videoCodec: 'h264', audioCodec: 'aac' }),
    ).toBe(true);
    expect(shouldTranscode({ mimeType: 'video/mp4', videoCodec: null, audioCodec: null })).toBe(
      false,
    );
  });

  it.skipIf(!hasFfmpeg)('writes an H.264 playback file and leaves the original', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ngp-playback-test-'));
    try {
      const mpeg = join(directory, 'mpeg.mp4');
      const h264 = join(directory, 'h264.mp4');
      expect(
        spawnSync(
          'ffmpeg',
          [
            '-y',
            '-f',
            'lavfi',
            '-i',
            'testsrc=size=160x120:rate=10',
            '-t',
            '0.3',
            '-c:v',
            'mpeg4',
            '-an',
            mpeg,
          ],
          { stdio: 'ignore' },
        ).status,
      ).toBe(0);
      expect(
        spawnSync(
          'ffmpeg',
          [
            '-y',
            '-f',
            'lavfi',
            '-i',
            'testsrc=size=160x120:rate=10',
            '-t',
            '0.3',
            '-c:v',
            'libx264',
            '-an',
            h264,
          ],
          { stdio: 'ignore' },
        ).status,
      ).toBe(0);
      const before = await readFile(mpeg);
      const user = await createUser(t.ctx, { email: 'playback@example.com' });
      const odd = await insertAsset(t.ctx, user.id, {
        bytes: before,
        type: 'video',
        mimeType: 'video/mp4',
        filename: 'clip.mp4',
      });
      expect(await ensurePlayback(t.ctx, odd, mpeg)).toBe('done');
      expect(await readFile(mpeg)).toEqual(before);
      const derived = await t.ctx.db
        .select({ kind: assetFiles.kind, mimeType: assetFiles.mimeType })
        .from(assetFiles)
        .where(eq(assetFiles.assetId, odd.id));
      expect(derived).toContainEqual({ kind: 'playback', mimeType: 'video/mp4' });

      const playable = await insertAsset(t.ctx, user.id, {
        bytes: await readFile(h264),
        type: 'video',
        mimeType: 'video/mp4',
        filename: 'playable.mp4',
      });
      expect(await ensurePlayback(t.ctx, playable, h264)).toBe('skipped');
      const untouched = await t.ctx.db
        .select({ kind: assetFiles.kind })
        .from(assetFiles)
        .where(eq(assetFiles.assetId, playable.id));
      expect(untouched.map((row) => row.kind)).not.toContain('playback');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
