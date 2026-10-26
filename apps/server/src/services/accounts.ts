import type { AdminUser, CurrentUser, StorageUsage } from '@ngp/shared';
import { count, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Context } from 'hono';
import { verifyAgainstDummy, verifyPassword } from '../auth/passwords';
import { createSession } from '../auth/sessions';
import type { AppContext } from '../context';
import type { DbOrTx } from '../db/client';
import { assets, devices, files, users, type UserRow } from '../db/schema';
import { clientIp } from '../http/client';
import { setSessionCookie } from '../http/cookies';
import { ApiError } from '../http/errors';

export function toCurrentUser(user: UserRow): CurrentUser {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    createdAt: user.createdAt.toISOString(),
  };
}

export async function countUsers(db: DbOrTx): Promise<number> {
  const [row] = await db.select({ value: count() }).from(users);
  return row?.value ?? 0;
}

export async function findUserByEmail(db: DbOrTx, email: string): Promise<UserRow | undefined> {
  const [user] = await db
    .select()
    .from(users)
    .where(sql`lower(${users.email}) = ${email.trim().toLowerCase()}`);
  return user;
}

/**
 * Checks an email and password. Unknown emails take as long as wrong passwords, and a disabled
 * account is only revealed to someone who knows its password.
 */
export async function authenticate(db: DbOrTx, email: string, password: string): Promise<UserRow> {
  const user = await findUserByEmail(db, email);
  if (!user) {
    await verifyAgainstDummy(password);
    if ((await countUsers(db)) === 0) {
      throw new ApiError('setup_required', 'This server has no accounts yet. Finish the first-run setup.');
    }
    throw new ApiError('invalid_credentials', 'Wrong email or password');
  }
  if (!(await verifyPassword(password, user.passwordHash))) {
    throw new ApiError('invalid_credentials', 'Wrong email or password');
  }
  if (user.disabledAt) {
    throw new ApiError('account_disabled', 'This account is disabled. Ask the server admin to turn it back on.');
  }
  return user;
}

/** Creates a browser session for the person and sets the cookie on the response. */
export async function startSession(c: Context, ctx: AppContext, userId: string): Promise<void> {
  const { token, session } = await createSession(ctx.db, {
    userId,
    userAgent: c.req.header('user-agent'),
    ip: clientIp(c, ctx.env),
    ttlDays: ctx.env.SESSION_TTL_DAYS,
  });
  setSessionCookie(c, ctx.env, token, session.expiresAt);
}

interface Usage {
  usedBytes: number;
  assetCount: number;
  byType: StorageUsage['byType'];
}

function emptyUsage(): Usage {
  return {
    usedBytes: 0,
    assetCount: 0,
    byType: { image: { count: 0, bytes: 0 }, video: { count: 0, bytes: 0 } },
  };
}

/**
 * Storage per person: the size of their originals, counted in full even when another account
 * has the same file (so moving a library elsewhere never surprises anyone).
 */
export async function storageUsageByUser(
  db: DbOrTx,
  userIds?: readonly string[],
): Promise<Map<string, Usage>> {
  const rows = await db
    .select({
      ownerId: assets.ownerId,
      type: assets.type,
      count: count(),
      bytes: sql<string>`coalesce(sum(${files.sizeBytes}), 0)`,
    })
    .from(assets)
    .innerJoin(files, eq(files.id, assets.fileId))
    .where(userIds ? inArray(assets.ownerId, [...userIds]) : undefined)
    .groupBy(assets.ownerId, assets.type);

  const result = new Map<string, Usage>();
  for (const id of userIds ?? []) result.set(id, emptyUsage());
  for (const row of rows) {
    const usage = result.get(row.ownerId) ?? emptyUsage();
    const bytes = Number(row.bytes);
    usage.byType[row.type] = { count: row.count, bytes };
    usage.usedBytes += bytes;
    usage.assetCount += row.count;
    result.set(row.ownerId, usage);
  }
  return result;
}

export async function storageUsageFor(db: DbOrTx, user: UserRow): Promise<StorageUsage> {
  const usage = (await storageUsageByUser(db, [user.id])).get(user.id) ?? emptyUsage();
  return { ...usage, quotaBytes: user.quotaBytes };
}

export async function activeDeviceCounts(db: DbOrTx): Promise<Map<string, number>> {
  const rows = await db
    .select({ userId: devices.userId, value: count() })
    .from(devices)
    .where(isNull(devices.revokedAt))
    .groupBy(devices.userId);
  return new Map(rows.map((row) => [row.userId, row.value]));
}

export function toAdminUser(user: UserRow, deviceCount: number, usage: Usage | undefined): AdminUser {
  const { usedBytes, assetCount } = usage ?? emptyUsage();
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    status: user.disabledAt ? 'disabled' : 'active',
    createdAt: user.createdAt.toISOString(),
    lastLoginAt: user.lastLoginAt?.toISOString() ?? null,
    deviceCount,
    storage: { usedBytes, quotaBytes: user.quotaBytes, assetCount },
  };
}
