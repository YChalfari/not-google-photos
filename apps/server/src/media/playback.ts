import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { and, eq } from 'drizzle-orm';
import type { AppContext } from '../context';
import { assetFiles, type AssetRow } from '../db/schema';

export interface PlaybackProbe {
  videoCodec: string | null;
  audioCodec: string | null;
}

/**
 * Desktop browsers play H.264 in an MP4 with AAC (or no audio). Phone videos are often HEVC
 * inside an MP4, which those browsers will not play.
 */
export function shouldTranscode(input: {
  mimeType: string | null;
  videoCodec: string | null;
  audioCodec: string | null;
}): boolean {
  if (!input.videoCodec) return (input.mimeType ?? '') !== 'video/mp4';
  const video = input.videoCodec.toLowerCase();
  const audio = input.audioCodec?.toLowerCase() ?? null;
  const playable =
    input.mimeType === 'video/mp4' && video === 'h264' && (audio == null || audio === 'aac');
  return !playable;
}

let ffprobeAvailable: Promise<boolean> | undefined;

function hasFfprobe(): Promise<boolean> {
  ffprobeAvailable ??= run('ffprobe', ['-version'], 10_000).then(
    (result) => result.code === 0,
    () => false,
  );
  return ffprobeAvailable;
}

function run(
  command: string,
  args: string[],
  timeoutMs: number,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        code: code ?? 1,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      });
    });
  });
}

export async function probePlayback(filePath: string): Promise<PlaybackProbe | null> {
  if (!(await hasFfprobe())) return null;
  const result = await run(
    'ffprobe',
    ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name', '-of', 'json', filePath],
    30_000,
  );
  if (result.code !== 0) return null;
  let parsed: { streams?: Array<{ codec_type?: string; codec_name?: string }> };
  try {
    parsed = JSON.parse(result.stdout) as typeof parsed;
  } catch {
    return null;
  }
  const streams = parsed.streams ?? [];
  const video = streams.find((stream) => stream.codec_type === 'video');
  const audio = streams.find((stream) => stream.codec_type === 'audio');
  return {
    videoCodec: video?.codec_name ?? null,
    audioCodec: audio?.codec_name ?? null,
  };
}

/**
 * Writes an H.264/AAC MP4 when the original will not play in a desktop browser.
 * The original file is left as it was. Missing ffmpeg skips the step.
 */
export async function ensurePlayback(
  ctx: AppContext,
  asset: AssetRow,
  sourcePath: string,
): Promise<'done' | 'skipped' | 'failed'> {
  if (asset.type !== 'video') return 'skipped';
  const [existing] = await ctx.db
    .select({ assetId: assetFiles.assetId })
    .from(assetFiles)
    .where(and(eq(assetFiles.assetId, asset.id), eq(assetFiles.kind, 'playback')));
  if (existing) return 'done';
  if (!(await hasFfprobe())) return 'skipped';

  let probe: PlaybackProbe | null;
  try {
    probe = await probePlayback(sourcePath);
  } catch (error) {
    ctx.log.warn({ err: error, assetId: asset.id }, 'Could not read the video codec');
    return 'failed';
  }
  if (!probe) {
    if ((asset.mimeType ?? '') === 'video/mp4') return 'skipped';
  } else if (
    !shouldTranscode({
      mimeType: asset.mimeType,
      videoCodec: probe.videoCodec,
      audioCodec: probe.audioCodec,
    })
  ) {
    return 'skipped';
  }

  const directory = await mkdtemp(join(tmpdir(), 'ngp-playback-'));
  const output = join(directory, 'playback.mp4');
  try {
    const args = [
      '-y',
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      sourcePath,
      '-map',
      '0:v:0',
      ...(probe?.audioCodec ? ['-map', '0:a:0'] : []),
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-crf',
      '28',
      '-vf',
      "scale=w='min(1280,iw)':h=-2",
      ...(probe?.audioCodec ? ['-c:a', 'aac', '-ac', '2', '-b:a', '128k'] : ['-an']),
      '-movflags',
      '+faststart',
      output,
    ];
    const result = await run('ffmpeg', args, 25 * 60 * 1000);
    if (result.code !== 0) {
      ctx.log.warn(
        { assetId: asset.id, stderr: result.stderr.slice(-500) },
        'Playback transcode failed',
      );
      return 'failed';
    }
    const bytes = await readFile(output);
    if (bytes.length === 0) return 'failed';
    const { file } = await ctx.files.ingest(bytes, { mimeType: 'video/mp4' });
    await ctx.db
      .insert(assetFiles)
      .values({
        assetId: asset.id,
        kind: 'playback',
        fileId: file.id,
        mimeType: 'video/mp4',
      })
      .onConflictDoUpdate({
        target: [assetFiles.assetId, assetFiles.kind],
        set: { fileId: file.id, mimeType: 'video/mp4' },
      });
    return 'done';
  } catch (error) {
    ctx.log.warn({ err: error, assetId: asset.id }, 'Playback transcode failed');
    return 'failed';
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
