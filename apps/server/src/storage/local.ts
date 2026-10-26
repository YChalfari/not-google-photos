import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  BlobNotFoundError,
  ChecksumMismatchError,
  PayloadTooLargeError,
  type BlobDigest,
  type BlobSource,
  type ByteRange,
  type PutOptions,
  type StorageProvider,
  type StoredBlob,
  type WriteGuard,
} from './provider';

const KEY_PATTERN = /^blobs\/[0-9a-f]{2}\/[0-9a-f]{2}\/[0-9a-f]{64}$/;

export function blobKeyFor(sha256: string): string {
  return `blobs/${sha256.slice(0, 2)}/${sha256.slice(2, 4)}/${sha256}`;
}

function toReadable(source: BlobSource): Readable {
  if (source instanceof Readable) return source;
  if (Buffer.isBuffer(source) || source instanceof Uint8Array) return Readable.from([source]);
  return Readable.from(source);
}

function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

/**
 * Stores blobs under `<root>/blobs/ab/cd/<sha256>`. Writes stream to `<root>/tmp/` while hashing,
 * are flushed to disk, then renamed into place, so a crash never leaves a partial blob behind.
 */
export class LocalStorageProvider implements StorageProvider {
  readonly kind = 'local' as const;

  constructor(
    private readonly root: string,
    private readonly guard?: WriteGuard,
  ) {}

  private pathFor(key: string): string {
    if (!KEY_PATTERN.test(key)) throw new Error(`Invalid storage key: ${key}`);
    return path.join(this.root, key);
  }

  async put(source: BlobSource, options: PutOptions = {}): Promise<StoredBlob> {
    await this.guard?.assertWritable();
    const tmpDir = path.join(this.root, 'tmp');
    await mkdir(tmpDir, { recursive: true });
    const tmpPath = path.join(tmpDir, `${randomUUID()}.part`);

    const sha1 = createHash('sha1');
    const sha256 = createHash('sha256');
    let size = 0;
    const hasher = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        size += chunk.length;
        if (options.maxBytes !== undefined && size > options.maxBytes) {
          callback(new PayloadTooLargeError(options.maxBytes));
          return;
        }
        sha1.update(chunk);
        sha256.update(chunk);
        callback(null, chunk);
      },
    });

    try {
      await pipeline(toReadable(source), hasher, createWriteStream(tmpPath, { flags: 'wx', flush: true }));
      const digest = { sha1: sha1.digest('hex'), sha256: sha256.digest('hex') };
      if (options.expectedSha1 && options.expectedSha1 !== digest.sha1) {
        throw new ChecksumMismatchError('sha1', options.expectedSha1, digest.sha1);
      }
      if (options.expectedSha256 && options.expectedSha256 !== digest.sha256) {
        throw new ChecksumMismatchError('sha256', options.expectedSha256, digest.sha256);
      }

      const key = blobKeyFor(digest.sha256);
      const finalPath = this.pathFor(key);
      const existing = await stat(finalPath).catch((error: unknown) => {
        if (isNotFound(error)) return null;
        throw error;
      });
      if (existing && existing.size === size) {
        await unlink(tmpPath);
        return { key, ...digest, size, deduplicated: true };
      }
      // Missing, or a damaged copy with the wrong size: (re)place it atomically.
      await mkdir(path.dirname(finalPath), { recursive: true });
      await rename(tmpPath, finalPath);
      return { key, ...digest, size, deduplicated: false };
    } catch (error) {
      await rm(tmpPath, { force: true });
      throw error;
    }
  }

  async open(key: string, range?: ByteRange): Promise<Readable> {
    const filePath = this.pathFor(key);
    try {
      await stat(filePath);
    } catch (error) {
      if (isNotFound(error)) throw new BlobNotFoundError(key);
      throw error;
    }
    return createReadStream(filePath, range ? { start: range.start, end: range.end } : undefined);
  }

  async stat(key: string): Promise<{ size: number } | null> {
    try {
      const info = await stat(this.pathFor(key));
      return { size: info.size };
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async digest(key: string): Promise<BlobDigest | null> {
    const sha1 = createHash('sha1');
    const sha256 = createHash('sha256');
    let size = 0;
    try {
      for await (const chunk of createReadStream(this.pathFor(key)) as AsyncIterable<Buffer>) {
        size += chunk.length;
        sha1.update(chunk);
        sha256.update(chunk);
      }
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
    return { sha1: sha1.digest('hex'), sha256: sha256.digest('hex'), size };
  }

  async delete(key: string): Promise<void> {
    await rm(this.pathFor(key), { force: true });
  }
}
