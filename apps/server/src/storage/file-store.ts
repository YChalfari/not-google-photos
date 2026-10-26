import { and, eq, lt, sql } from 'drizzle-orm';
import type { Readable } from 'node:stream';
import type { Db, DbOrTx } from '../db/client';
import { files, type FileRow } from '../db/schema';
import type { BlobSource, ByteRange, StorageProvider } from './provider';

export type VerifyResult = 'verified' | 'missing' | 'mismatch';

/**
 * The `files` table on top of a {@link StorageProvider}: one row per unique blob (by SHA-256),
 * shared by every asset and derived copy that has the same bytes, in any account.
 */
export class FileStore {
  constructor(
    private readonly db: Db,
    readonly storage: StorageProvider,
  ) {}

  /**
   * Streams bytes into storage and returns the `files` row for them, creating it when new.
   * Reference counts are kept by database triggers: point an `assets` or `asset_files` row at the
   * returned file id and the count follows.
   */
  async ingest(
    source: BlobSource,
    options: { expectedSha1?: string; mimeType?: string | null; maxBytes?: number } = {},
  ): Promise<{ file: FileRow; created: boolean }> {
    const stored = await this.storage.put(source, {
      expectedSha1: options.expectedSha1,
      maxBytes: options.maxBytes,
    });
    const [inserted] = await this.db
      .insert(files)
      .values({
        sha256: stored.sha256,
        sha1: stored.sha1,
        sizeBytes: stored.size,
        storageKey: stored.key,
        mimeType: options.mimeType ?? null,
        verifiedAt: new Date(),
      })
      .onConflictDoNothing({ target: files.sha256 })
      .returning();
    if (inserted) return { file: inserted, created: true };
    const [existing] = await this.db.select().from(files).where(eq(files.sha256, stored.sha256));
    if (!existing) throw new Error(`File row for ${stored.sha256} vanished during ingest`);
    return { file: existing, created: false };
  }

  async get(fileId: string, db: DbOrTx = this.db): Promise<FileRow | undefined> {
    const [row] = await db.select().from(files).where(eq(files.id, fileId));
    return row;
  }

  open(file: Pick<FileRow, 'storageKey'>, range?: ByteRange): Promise<Readable> {
    return this.storage.open(file.storageKey, range);
  }

  /** Re-hashes the stored bytes and compares them with what the database recorded. */
  async verify(file: FileRow): Promise<VerifyResult> {
    const digest = await this.storage.digest(file.storageKey);
    if (!digest) return 'missing';
    if (digest.size !== file.sizeBytes || digest.sha256 !== file.sha256 || digest.sha1 !== file.sha1) {
      return 'mismatch';
    }
    await this.db.update(files).set({ verifiedAt: new Date() }).where(eq(files.id, file.id));
    return 'verified';
  }

  /**
   * Deletes blobs nothing points at any more. The grace period protects uploads that stored their
   * blob but haven't inserted the asset row yet.
   */
  async collectGarbage(options: { graceMs?: number; limit?: number } = {}): Promise<number> {
    const cutoff = new Date(Date.now() - (options.graceMs ?? 60 * 60 * 1000));
    const candidates = await this.db
      .select({ id: files.id })
      .from(files)
      .where(and(eq(files.refCount, 0), lt(files.createdAt, cutoff)))
      .limit(options.limit ?? 500);
    let removed = 0;
    for (const { id } of candidates) {
      try {
        const [row] = await this.db
          .delete(files)
          .where(and(eq(files.id, id), eq(files.refCount, 0)))
          .returning({ storageKey: files.storageKey });
        if (!row) continue;
        await this.storage.delete(row.storageKey);
        removed += 1;
      } catch {
        // A new reference raced in (the foreign key stopped the delete); keep the file.
      }
    }
    return removed;
  }

  /** Total bytes stored once per unique blob (what the library actually uses on disk). */
  async physicalBytes(): Promise<number> {
    const [row] = await this.db
      .select({ bytes: sql<string>`coalesce(sum(${files.sizeBytes}), 0)` })
      .from(files);
    return Number(row?.bytes ?? 0);
  }
}
