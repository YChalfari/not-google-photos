import { and, isNotNull, lt, or } from 'drizzle-orm';
import { deleteExpiredSessions } from '../auth/sessions';
import type { Db } from '../db/client';
import { assets, pairingCodes } from '../db/schema';
import type { FileStore } from '../storage/file-store';

const DAY_MS = 86_400_000;
/** Trash is restorable until this age, then the asset row is deleted and the blob can be collected. */
const TRASH_DAYS = 30;

/** Expired sessions, used pairing codes, and assets that have been in the trash for 30 days. */
export async function cleanupExpired(db: Db, now = new Date()) {
  const sessions = await deleteExpiredSessions(db, now);
  const cutoff = new Date(now.getTime() - DAY_MS);
  const codes = await db
    .delete(pairingCodes)
    .where(
      or(
        lt(pairingCodes.expiresAt, cutoff),
        and(isNotNull(pairingCodes.usedAt), lt(pairingCodes.usedAt, cutoff)),
      ),
    )
    .returning({ id: pairingCodes.id });
  const trashed = await db
    .delete(assets)
    .where(
      and(
        isNotNull(assets.trashedAt),
        lt(assets.trashedAt, new Date(now.getTime() - TRASH_DAYS * DAY_MS)),
      ),
    )
    .returning({ id: assets.id });
  return { sessions, pairingCodes: codes.length, trashedAssets: trashed.length };
}

/** Removes blobs no asset or derived copy points at any more. */
export async function collectUnreferencedFiles(files: FileStore) {
  let removed = 0;
  for (;;) {
    const batch = await files.collectGarbage({ limit: 500 });
    removed += batch;
    if (batch < 500) return { removed };
  }
}
