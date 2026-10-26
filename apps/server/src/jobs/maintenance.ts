import { and, isNotNull, lt, or } from 'drizzle-orm';
import { deleteExpiredSessions } from '../auth/sessions';
import type { Db } from '../db/client';
import { pairingCodes } from '../db/schema';
import type { FileStore } from '../storage/file-store';

const DAY_MS = 86_400_000;

/** Expired sessions, and pairing codes a day after they expired or were used. */
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
  return { sessions, pairingCodes: codes.length };
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
