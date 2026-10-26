import { TOKEN_PREFIX } from '@ngp/shared';
import { and, eq, gt, lt, ne } from 'drizzle-orm';
import type { DbOrTx } from '../db/client';
import { sessions, users, type SessionRow, type UserRow } from '../db/schema';
import { generateToken, hashToken } from './tokens';

const DAY_MS = 86_400_000;
/** How often a session's last-seen time (and sliding expiry) is written back. */
const TOUCH_INTERVAL_MS = 10 * 60 * 1000;

export interface NewSession {
  token: string;
  session: SessionRow;
}

export async function createSession(
  db: DbOrTx,
  input: { userId: string; userAgent?: string | null; ip?: string | null; ttlDays: number },
): Promise<NewSession> {
  const token = generateToken(TOKEN_PREFIX.session);
  const [session] = await db
    .insert(sessions)
    .values({
      userId: input.userId,
      tokenHash: hashToken(token),
      userAgent: input.userAgent?.slice(0, 400) ?? null,
      ip: input.ip ?? null,
      expiresAt: new Date(Date.now() + input.ttlDays * DAY_MS),
    })
    .returning();
  if (!session) throw new Error('Session insert returned nothing');
  return { token, session };
}

export interface ResolvedSession {
  session: SessionRow;
  user: UserRow;
  /** The expiry moved forward; re-send the cookie so the browser keeps it as long. */
  refreshed: boolean;
}

/** Active sessions of enabled accounts only. Sliding expiry: each use extends it by the TTL. */
export async function resolveSession(
  db: DbOrTx,
  token: string,
  ttlDays: number,
): Promise<ResolvedSession | null> {
  if (!token.startsWith(TOKEN_PREFIX.session)) return null;
  const now = new Date();
  const [row] = await db
    .select({ session: sessions, user: users })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.tokenHash, hashToken(token)), gt(sessions.expiresAt, now)));
  if (!row || row.user.disabledAt) return null;

  if (now.getTime() - row.session.lastSeenAt.getTime() < TOUCH_INTERVAL_MS) {
    return { ...row, refreshed: false };
  }
  const expiresAt = new Date(now.getTime() + ttlDays * DAY_MS);
  await db.update(sessions).set({ lastSeenAt: now, expiresAt }).where(eq(sessions.id, row.session.id));
  return { session: { ...row.session, lastSeenAt: now, expiresAt }, user: row.user, refreshed: true };
}

export async function deleteSession(db: DbOrTx, sessionId: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.id, sessionId));
}

/** Signs a person out of every browser, optionally keeping one session. */
export async function deleteUserSessions(
  db: DbOrTx,
  userId: string,
  options: { exceptSessionId?: string } = {},
): Promise<void> {
  await db
    .delete(sessions)
    .where(
      options.exceptSessionId
        ? and(eq(sessions.userId, userId), ne(sessions.id, options.exceptSessionId))
        : eq(sessions.userId, userId),
    );
}

export async function deleteExpiredSessions(db: DbOrTx, now = new Date()): Promise<number> {
  const removed = await db
    .delete(sessions)
    .where(lt(sessions.expiresAt, now))
    .returning({ id: sessions.id });
  return removed.length;
}
