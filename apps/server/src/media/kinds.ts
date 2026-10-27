import path from 'node:path';
import type { AssetType } from '@ngp/shared';

const BY_EXTENSION: Record<string, { type: AssetType; mime: string }> = {
  jpg: { type: 'image', mime: 'image/jpeg' },
  jpeg: { type: 'image', mime: 'image/jpeg' },
  png: { type: 'image', mime: 'image/png' },
  webp: { type: 'image', mime: 'image/webp' },
  gif: { type: 'image', mime: 'image/gif' },
  heic: { type: 'image', mime: 'image/heic' },
  heif: { type: 'image', mime: 'image/heif' },
  avif: { type: 'image', mime: 'image/avif' },
  tif: { type: 'image', mime: 'image/tiff' },
  tiff: { type: 'image', mime: 'image/tiff' },
  bmp: { type: 'image', mime: 'image/bmp' },
  mp4: { type: 'video', mime: 'video/mp4' },
  m4v: { type: 'video', mime: 'video/mp4' },
  mov: { type: 'video', mime: 'video/quicktime' },
  webm: { type: 'video', mime: 'video/webm' },
  mkv: { type: 'video', mime: 'video/x-matroska' },
  '3gp': { type: 'video', mime: 'video/3gpp' },
  mpeg: { type: 'video', mime: 'video/mpeg' },
  mpg: { type: 'video', mime: 'video/mpeg' },
};

const BY_MIME: Record<string, AssetType> = {};
for (const entry of Object.values(BY_EXTENSION)) BY_MIME[entry.mime] = entry.type;

export interface ClassifiedMedia {
  type: AssetType;
  mime: string;
}

function cleanMime(value: string | undefined): string | undefined {
  const mime = value?.split(';')[0]?.trim().toLowerCase();
  if (!mime || mime === 'application/octet-stream') return undefined;
  return mime;
}

/** Photos and videos the library accepts. Anything else is refused before it is kept. */
export function classifyUpload(
  filename: string,
  ...declared: Array<string | undefined>
): ClassifiedMedia | null {
  for (const mime of declared.map(cleanMime)) {
    if (mime && BY_MIME[mime]) return { type: BY_MIME[mime], mime };
  }
  const ext = path.extname(filename).slice(1).toLowerCase();
  return BY_EXTENSION[ext] ?? null;
}

/** The name stored on the asset: no directory, and no empty or traversal names. */
export function originalFilename(filename: string): string {
  const base = path.basename(filename.replaceAll('\\', '/')).trim();
  if (!base || base === '.' || base === '..') return 'upload';
  return base.slice(0, 255);
}
