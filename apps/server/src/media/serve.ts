import { Readable } from 'node:stream';
import type { MediaVariant } from '@ngp/shared';
import { and, eq, inArray } from 'drizzle-orm';
import type { Context } from 'hono';
import type { DbOrTx } from '../db/client';
import { assetFiles, assets, files, type FileRow } from '../db/schema';
import type { FileStore } from '../storage/file-store';
import type { ByteRange } from '../storage/provider';

/** Types served with their own Content-Type. Anything else is sent as a download. */
const INLINE_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/avif',
  'image/heic',
  'image/heif',
  'image/tiff',
  'image/bmp',
  'video/mp4',
  'video/quicktime',
  'video/webm',
  'video/x-matroska',
  'video/3gpp',
  'video/mpeg',
]);

export interface MediaFile {
  file: FileRow;
  mimeType: string | null;
  filename: string | null;
}

const DERIVED_KIND = { thumbnail: 'thumbnail', preview: 'preview', playback: 'playback' } as const;

/** The stored file behind one variant of an asset, or `null` when that variant doesn't exist yet. */
export async function resolveMediaFile(
  db: DbOrTx,
  assetId: string,
  variant: MediaVariant,
): Promise<MediaFile | null> {
  if (variant === 'original') {
    const [row] = await db
      .select({ file: files, mimeType: assets.mimeType, filename: assets.originalFilename })
      .from(assets)
      .innerJoin(files, eq(files.id, assets.fileId))
      .where(eq(assets.id, assetId));
    return row
      ? { file: row.file, mimeType: row.mimeType ?? row.file.mimeType, filename: row.filename }
      : null;
  }
  const [row] = await db
    .select({ file: files, mimeType: assetFiles.mimeType })
    .from(assetFiles)
    .innerJoin(files, eq(files.id, assetFiles.fileId))
    .where(and(eq(assetFiles.assetId, assetId), eq(assetFiles.kind, DERIVED_KIND[variant])));
  return row
    ? { file: row.file, mimeType: row.mimeType ?? row.file.mimeType, filename: null }
    : null;
}

/** Which variants exist for each asset (`original` always does). */
export async function availableVariants(
  db: DbOrTx,
  assetIds: readonly string[],
): Promise<Map<string, Set<MediaVariant>>> {
  const result = new Map<string, Set<MediaVariant>>();
  if (assetIds.length === 0) return result;
  for (const id of assetIds) result.set(id, new Set<MediaVariant>(['original']));
  const rows = await db
    .select({ assetId: assetFiles.assetId, kind: assetFiles.kind })
    .from(assetFiles)
    .where(inArray(assetFiles.assetId, [...new Set(assetIds)]));
  for (const row of rows) result.get(row.assetId)?.add(row.kind);
  return result;
}

function parseRange(header: string | undefined, size: number): ByteRange | 'invalid' | null {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null; // Multiple or unknown ranges: send the whole file.
  const [, startText = '', endText = ''] = match;
  if (startText === '' && endText === '') return 'invalid';
  let start: number;
  let end: number;
  if (startText === '') {
    const suffix = Number(endText);
    if (suffix === 0) return 'invalid';
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(startText);
    end = endText === '' ? size - 1 : Math.min(Number(endText), size - 1);
  }
  if (start >= size || start > end) return 'invalid';
  return { start, end };
}

function contentDisposition(kind: 'inline' | 'attachment', filename: string | null): string {
  if (!filename) return kind;
  const fallback = filename.replace(/[^\x20-\x7e]|["\\]/g, '_');
  return `${kind}; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

/**
 * Streams a stored file with Range and ETag support. The ETag is the SHA-256, so it never goes
 * stale. Media is locked down (`nosniff`, sandboxed CSP) because uploads are user content.
 */
export async function sendMediaFile(
  c: Context,
  store: FileStore,
  media: MediaFile,
  options: { maxAgeSeconds: number },
): Promise<Response> {
  const { file } = media;
  const mime = media.mimeType?.toLowerCase() ?? '';
  const inline = INLINE_MIME_TYPES.has(mime);
  const etag = `"${file.sha256}"`;
  const headers: Record<string, string> = {
    'Accept-Ranges': 'bytes',
    'Cache-Control': `private, max-age=${Math.max(0, Math.floor(options.maxAgeSeconds))}`,
    'Content-Security-Policy': "default-src 'none'; sandbox",
    'Content-Type': inline ? mime : 'application/octet-stream',
    'Content-Disposition': contentDisposition(inline ? 'inline' : 'attachment', media.filename),
    'Cross-Origin-Resource-Policy': 'cross-origin',
    ETag: etag,
    'X-Content-Type-Options': 'nosniff',
  };

  const ifNoneMatch = c.req.header('if-none-match');
  if (
    ifNoneMatch &&
    ifNoneMatch.split(',').some((tag) => tag.trim().replace(/^W\//, '') === etag)
  ) {
    return new Response(null, { status: 304, headers });
  }

  const size = file.sizeBytes;
  const ifRange = c.req.header('if-range');
  const rangeHeader = ifRange && ifRange !== etag ? undefined : c.req.header('range');
  const range = parseRange(rangeHeader, size);
  if (range === 'invalid') {
    return new Response(null, {
      status: 416,
      headers: { ...headers, 'Content-Range': `bytes */${size}` },
    });
  }

  // Hono answers HEAD by running the GET route and dropping the body, so don't open a stream.
  const body =
    c.req.raw.method === 'HEAD'
      ? null
      : (Readable.toWeb(await store.open(file, range ?? undefined)) as ReadableStream<Uint8Array>);
  if (range) {
    return new Response(body, {
      status: 206,
      headers: {
        ...headers,
        'Content-Length': String(range.end - range.start + 1),
        'Content-Range': `bytes ${range.start}-${range.end}/${size}`,
      },
    });
  }
  return new Response(body, {
    status: 200,
    headers: { ...headers, 'Content-Length': String(size) },
  });
}
