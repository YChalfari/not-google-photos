import { asc, gt, sql } from 'drizzle-orm';
import type { AppContext } from '../context';
import { files } from '../db/schema';

/** Enough to notice a bad disk, and small enough to finish overnight. */
const MAX_FILES = 80;
const MAX_BYTES = 512 * 1024 * 1024;

export interface VerifyBatch {
  verified: number;
  missing: number;
  mismatch: number;
  bytes: number;
}

/**
 * Re-hashes a bounded slice of stored files, oldest check first, and records the result.
 * A missing file or a hash mismatch is logged. The file is not deleted or rewritten.
 */
export async function verifyStoredFiles(ctx: AppContext): Promise<VerifyBatch> {
  const rows = await ctx.db
    .select()
    .from(files)
    .where(gt(files.refCount, 0))
    .orderBy(sql`${files.verifiedAt} asc nulls first`, asc(files.createdAt))
    .limit(MAX_FILES);

  const result: VerifyBatch = { verified: 0, missing: 0, mismatch: 0, bytes: 0 };
  for (const file of rows) {
    if (result.verified + result.missing + result.mismatch > 0 && result.bytes >= MAX_BYTES) break;
    const verdict = await ctx.files.verify(file);
    result.bytes += file.sizeBytes;
    if (verdict === 'verified') result.verified += 1;
    else if (verdict === 'missing') result.missing += 1;
    else result.mismatch += 1;
  }

  if (result.missing > 0 || result.mismatch > 0) {
    ctx.log.warn(result, 'Stored files do not match');
  } else if (result.verified > 0) {
    ctx.log.info(result, 'Checked stored files');
  }
  return result;
}
