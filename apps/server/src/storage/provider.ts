import type { Readable } from 'node:stream';
import type { LibraryStatus } from '@ngp/shared';

/** Anything we can stream into storage. */
export type BlobSource = Readable | Buffer | Uint8Array | AsyncIterable<Uint8Array>;

export interface ByteRange {
  start: number;
  /** Inclusive. */
  end: number;
}

export interface PutOptions {
  /** Reject the write (and keep nothing) unless the bytes hash to this SHA-1. */
  expectedSha1?: string;
  expectedSha256?: string;
  /** Abort once more than this many bytes arrive. */
  maxBytes?: number;
}

export interface StoredBlob {
  /** Opaque key derived from the SHA-256; store it in `files.storage_key`. */
  key: string;
  sha256: string;
  sha1: string;
  size: number;
  /** The same bytes were already stored, so nothing new was written. */
  deduplicated: boolean;
}

export interface BlobDigest {
  sha256: string;
  sha1: string;
  size: number;
}

/**
 * Content-addressed blob storage: identical bytes are stored once, whoever uploads them.
 * `LocalStorageProvider` writes to the library folder; an S3-compatible provider can implement
 * the same interface later.
 */
export interface StorageProvider {
  readonly kind: 'local' | 's3';
  put(source: BlobSource, options?: PutOptions): Promise<StoredBlob>;
  /** Throws {@link BlobNotFoundError} when the key doesn't exist. */
  open(key: string, range?: ByteRange): Promise<Readable>;
  stat(key: string): Promise<{ size: number } | null>;
  /** Re-reads the stored bytes; `null` when missing. Used before phones delete their copies. */
  digest(key: string): Promise<BlobDigest | null>;
  delete(key: string): Promise<void>;
}

/** Lets the provider refuse writes, e.g. when the library drive is unplugged. */
export interface WriteGuard {
  assertWritable(): Promise<void>;
}

export class BlobNotFoundError extends Error {
  constructor(readonly key: string) {
    super(`Blob not found: ${key}`);
    this.name = 'BlobNotFoundError';
  }
}

export class ChecksumMismatchError extends Error {
  constructor(
    readonly algorithm: 'sha1' | 'sha256',
    readonly expected: string,
    readonly actual: string,
  ) {
    super(`The uploaded bytes don't match the ${algorithm.toUpperCase()} the client sent`);
    this.name = 'ChecksumMismatchError';
  }
}

export class PayloadTooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super(`The upload is larger than the ${maxBytes}-byte limit`);
    this.name = 'PayloadTooLargeError';
  }
}

export class LibraryUnavailableError extends Error {
  constructor(readonly status: LibraryStatus) {
    super(status.message);
    this.name = 'LibraryUnavailableError';
  }
}
