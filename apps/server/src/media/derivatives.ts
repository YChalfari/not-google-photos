import { spawn } from 'node:child_process';
import { eq, sql } from 'drizzle-orm';
import exifr from 'exifr';
import sharp from 'sharp';
import { rgbaToThumbHash } from 'thumbhash';
import type { AppContext } from '../context';
import { assetFiles, assets, type AssetRow, type FileRow } from '../db/schema';
import { LocalStorageProvider } from '../storage/local';
import { partsFromExif } from './time';

const THUMB_EDGE = 480;
const PREVIEW_EDGE = 2048;

export interface ExifPatch {
  capturedAt?: Date;
  localDate?: string;
  wallClock?: string;
  timezone?: string;
  latitude?: number;
  longitude?: number;
  make?: string;
  model?: string;
  lens?: string;
  extra?: Record<string, unknown>;
}

let ffmpegAvailable: Promise<boolean> | undefined;

function text(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.replace(/\0/g, '').trim();
  return trimmed || undefined;
}

function number(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Reads the capture time, camera, and GPS the file itself carries. Missing EXIF is normal. */
export async function readExif(filePath: string, fallbackZone: string): Promise<ExifPatch | null> {
  const tags = (await exifr.parse(filePath, { reviveValues: false })) as
    Record<string, unknown> | undefined;
  const gps = (await exifr.gps(filePath).catch(() => undefined)) as
    { latitude?: number; longitude?: number } | undefined;
  if (!tags && !gps) return null;

  const stamp = text(tags?.DateTimeOriginal) ?? text(tags?.CreateDate) ?? text(tags?.DateTime);
  const offset = text(tags?.OffsetTimeOriginal) ?? text(tags?.OffsetTime);
  const when = stamp ? partsFromExif(stamp, offset, fallbackZone) : null;
  const extra: Record<string, unknown> = {};
  const iso = number(tags?.ISO) ?? number(tags?.ISOSpeedRatings);
  const aperture = number(tags?.FNumber);
  const exposure = number(tags?.ExposureTime);
  const focal = number(tags?.FocalLength);
  if (iso !== undefined) extra.iso = iso;
  if (aperture !== undefined) extra.fNumber = aperture;
  if (exposure !== undefined) extra.exposureTime = exposure;
  if (focal !== undefined) extra.focalLength = focal;

  const patch: ExifPatch = {};
  if (when) {
    patch.capturedAt = when.capturedAt;
    patch.localDate = when.localDate;
    patch.wallClock = when.wallClock;
    patch.timezone = when.timezone;
  }
  if (typeof gps?.latitude === 'number' && typeof gps.longitude === 'number') {
    patch.latitude = gps.latitude;
    patch.longitude = gps.longitude;
  }
  const make = text(tags?.Make);
  const model = text(tags?.Model);
  const lens = text(tags?.LensModel);
  if (make) patch.make = make.slice(0, 120);
  if (model) patch.model = model.slice(0, 120);
  if (lens) patch.lens = lens.slice(0, 120);
  if (Object.keys(extra).length > 0) patch.extra = extra;
  return Object.keys(patch).length > 0 ? patch : null;
}

async function hasFfmpeg(): Promise<boolean> {
  ffmpegAvailable ??= new Promise((resolve) => {
    const child = spawn('ffmpeg', ['-version'], { stdio: 'ignore' });
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0));
  });
  return ffmpegAvailable;
}

/** One JPEG frame from a video, or null when ffmpeg is missing or the file has no picture. */
async function videoPoster(filePath: string): Promise<Buffer | null> {
  if (!(await hasFfmpeg())) return null;
  return new Promise((resolve) => {
    const child = spawn(
      'ffmpeg',
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-ss',
        '0.5',
        '-i',
        filePath,
        '-frames:v',
        '1',
        '-f',
        'image2',
        '-vcodec',
        'mjpeg',
        'pipe:1',
      ],
      { stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const chunks: Buffer[] = [];
    let size = 0;
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 20 * 1024 * 1024) {
        child.kill();
        return;
      }
      chunks.push(chunk);
    });
    child.on('error', () => resolve(null));
    child.on('close', (code) => {
      const bytes = Buffer.concat(chunks);
      resolve(code === 0 && bytes.length > 0 ? bytes : null);
    });
  });
}

async function thumbhashOf(input: Buffer): Promise<string> {
  const { data, info } = await sharp(input)
    .rotate()
    .resize(100, 100, { fit: 'inside', withoutEnlargement: true })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return Buffer.from(rgbaToThumbHash(info.width, info.height, data)).toString('base64');
}

async function webp(
  input: string | Buffer,
  edge: number,
): Promise<{ bytes: Buffer; width: number; height: number }> {
  const { data, info } = await sharp(input, { failOn: 'none' })
    .rotate()
    .resize(edge, edge, { fit: 'inside', withoutEnlargement: true })
    .webp({ quality: edge > THUMB_EDGE ? 80 : 72 })
    .toBuffer({ resolveWithObject: true });
  return { bytes: data, width: info.width, height: info.height };
}

async function orientedSize(
  input: string | Buffer,
): Promise<{ width: number; height: number } | null> {
  const meta = await sharp(input, { failOn: 'none' }).rotate().metadata();
  if (!meta.width || !meta.height) return null;
  return { width: meta.width, height: meta.height };
}

/**
 * Builds the grid thumbnail and the viewer preview, and (unless `exif` is false) lets the
 * file's own capture time and GPS replace what the phone sent. Safe to run again.
 */
export async function processAsset(
  ctx: AppContext,
  assetId: string,
  options: { exif?: boolean } = {},
): Promise<void> {
  const [asset] = await ctx.db.select().from(assets).where(eq(assets.id, assetId));
  if (!asset) return;
  const file = await ctx.files.get(asset.fileId);
  if (!file) return;
  if (!(ctx.storage instanceof LocalStorageProvider)) {
    await mark(ctx, asset, { thumbnails: 'skipped' }, 'ready');
    return;
  }

  const source = ctx.storage.localPath(file.storageKey);
  const steps: Record<string, string> = { ...asset.processingSteps };
  try {
    await ctx.db
      .update(assets)
      .set({ processingState: 'processing' })
      .where(eq(assets.id, asset.id));

    const exif =
      options.exif === false
        ? null
        : await readExif(source, asset.timezone ?? 'UTC').catch(() => null);
    if (options.exif !== false) steps.metadata = exif ? 'done' : 'skipped';

    const picture = asset.type === 'video' ? await videoPoster(source) : source;
    if (!picture) {
      steps.thumbnails = 'skipped';
      await mark(ctx, asset, steps, 'ready', exif);
      return;
    }

    const size = await orientedSize(picture);
    const thumbnail = await webp(picture, THUMB_EDGE);
    const preview = await webp(picture, PREVIEW_EDGE);
    const thumbhash = await thumbhashOf(thumbnail.bytes);
    await storeDerived(ctx, asset, file, 'thumbnail', thumbnail);
    await storeDerived(ctx, asset, file, 'preview', preview);
    steps.thumbnails = 'done';
    await mark(ctx, asset, steps, 'ready', exif, {
      width: size?.width,
      height: size?.height,
      thumbhash,
    });
  } catch (error) {
    steps.thumbnails = 'failed';
    await mark(ctx, asset, steps, 'failed');
    throw error;
  }
}

async function storeDerived(
  ctx: AppContext,
  asset: AssetRow,
  original: FileRow,
  kind: 'thumbnail' | 'preview',
  image: { bytes: Buffer; width: number; height: number },
) {
  const { file } = await ctx.files.ingest(image.bytes, { mimeType: 'image/webp' });
  if (file.id === original.id) return;
  await ctx.db
    .insert(assetFiles)
    .values({
      assetId: asset.id,
      kind,
      fileId: file.id,
      width: image.width,
      height: image.height,
      mimeType: 'image/webp',
    })
    .onConflictDoUpdate({
      target: [assetFiles.assetId, assetFiles.kind],
      set: { fileId: file.id, width: image.width, height: image.height, mimeType: 'image/webp' },
    });
}

async function mark(
  ctx: AppContext,
  asset: AssetRow,
  steps: Record<string, string>,
  state: 'ready' | 'failed',
  exif?: ExifPatch | null,
  image?: { width?: number; height?: number; thumbhash?: string },
) {
  await ctx.db
    .update(assets)
    .set({
      processingState: state,
      processingSteps: steps,
      ...(image?.width ? { width: image.width } : {}),
      ...(image?.height ? { height: image.height } : {}),
      ...(image?.thumbhash ? { thumbhash: image.thumbhash } : {}),
      ...(exif?.capturedAt ? { capturedAt: exif.capturedAt } : {}),
      ...(exif?.localDate ? { localDate: exif.localDate } : {}),
      ...(exif?.wallClock ? { capturedLocal: sql`${exif.wallClock}::timestamp` } : {}),
      ...(exif?.timezone ? { timezone: exif.timezone } : {}),
      ...(exif?.latitude !== undefined ? { latitude: exif.latitude } : {}),
      ...(exif?.longitude !== undefined ? { longitude: exif.longitude } : {}),
      ...(exif?.make ? { cameraMake: exif.make } : {}),
      ...(exif?.model ? { cameraModel: exif.model } : {}),
      ...(exif?.lens ? { lensModel: exif.lens } : {}),
      ...(exif?.extra ? { exif: exif.extra } : {}),
    })
    .where(eq(assets.id, asset.id));
}

/** Runs thumbnail work now when the queue is off (tests, and a server started without jobs). */
export async function scheduleAssetProcessing(ctx: AppContext, assetId: string): Promise<void> {
  if (ctx.jobs?.isRunning()) {
    await ctx.jobs.enqueueAsset(assetId);
    return;
  }
  try {
    await processAsset(ctx, assetId);
  } catch (error) {
    ctx.log.error({ err: error, assetId }, 'Could not build thumbnails');
    if (ctx.env.NODE_ENV === 'test') throw error;
  }
}
