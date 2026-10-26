import { TOKEN_PREFIX, type DeviceInfo } from '@ngp/shared';
import { and, eq, isNull } from 'drizzle-orm';
import type { z } from 'zod';
import type { DbOrTx } from '../db/client';
import { devices, users, type DeviceRow, type UserRow } from '../db/schema';
import { generateToken, hashToken } from './tokens';

/** How often a device's last-seen time and IP are written back. */
const TOUCH_INTERVAL_MS = 5 * 60 * 1000;

export type DeviceDetails = z.output<typeof DeviceInfo>;

export async function createDevice(
  db: DbOrTx,
  input: { userId: string; info: DeviceDetails; ip?: string | null },
): Promise<{ token: string; device: DeviceRow }> {
  const token = generateToken(TOKEN_PREFIX.device);
  const [device] = await db
    .insert(devices)
    .values({
      userId: input.userId,
      name: input.info.name,
      platform: input.info.platform,
      model: input.info.model ?? null,
      osVersion: input.info.osVersion ?? null,
      appVersion: input.info.appVersion ?? null,
      tokenHash: hashToken(token),
      lastSeenAt: new Date(),
      lastIp: input.ip ?? null,
    })
    .returning();
  if (!device) throw new Error('Device insert returned nothing');
  return { token, device };
}

/** Device tokens of enabled accounts that haven't been revoked. */
export async function resolveDeviceToken(
  db: DbOrTx,
  token: string,
  ip: string | null,
): Promise<{ device: DeviceRow; user: UserRow } | null> {
  if (!token.startsWith(TOKEN_PREFIX.device)) return null;
  const [row] = await db
    .select({ device: devices, user: users })
    .from(devices)
    .innerJoin(users, eq(users.id, devices.userId))
    .where(and(eq(devices.tokenHash, hashToken(token)), isNull(devices.revokedAt)));
  if (!row || row.user.disabledAt) return null;

  const now = new Date();
  const lastSeen = row.device.lastSeenAt?.getTime() ?? 0;
  if (now.getTime() - lastSeen >= TOUCH_INTERVAL_MS || (ip && ip !== row.device.lastIp)) {
    await db.update(devices).set({ lastSeenAt: now, lastIp: ip }).where(eq(devices.id, row.device.id));
    row.device = { ...row.device, lastSeenAt: now, lastIp: ip };
  }
  return row;
}

export async function revokeDevice(db: DbOrTx, userId: string, deviceId: string): Promise<boolean> {
  const revoked = await db
    .update(devices)
    .set({ revokedAt: new Date() })
    .where(and(eq(devices.id, deviceId), eq(devices.userId, userId), isNull(devices.revokedAt)))
    .returning({ id: devices.id });
  return revoked.length > 0;
}
