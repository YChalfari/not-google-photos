import {
  PAIRING_CODE_TTL_SECONDS,
  encodePairingUri,
  formatPairingCode,
  type Device,
  type PairingPayload,
} from '@ngp/shared';
import { and, desc, eq, gt, isNull } from 'drizzle-orm';
import { createDevice, revokeDevice } from '../auth/devices';
import { generatePairingCode, hashToken } from '../auth/tokens';
import { devices, pairingCodes, users, type DeviceRow } from '../db/schema';
import { clientIp, isLoopbackOrigin, requestOrigin } from '../http/client';
import type { Handlers } from '../http/contract';
import { ApiError, isUniqueViolation } from '../http/errors';
import { enforceRateLimit } from '../http/rate-limit';
import { authenticate, toCurrentUser } from '../services/accounts';
import { effectiveAddresses, getServerConfig } from '../services/server-config';

function toDevice(device: DeviceRow, currentDeviceId: string | null): Device {
  return {
    id: device.id,
    name: device.name,
    platform: device.platform,
    model: device.model,
    osVersion: device.osVersion,
    appVersion: device.appVersion,
    createdAt: device.createdAt.toISOString(),
    lastSeenAt: device.lastSeenAt?.toISOString() ?? null,
    isCurrent: device.id === currentDeviceId,
  };
}

export const deviceHandlers: Handlers = {
  'devices.list': async ({ ctx, auth }) => {
    const rows = await ctx.db
      .select()
      .from(devices)
      .where(and(eq(devices.userId, auth.user.id), isNull(devices.revokedAt)))
      .orderBy(desc(devices.createdAt));
    return { devices: rows.map((row) => toDevice(row, auth.device?.id ?? null)) };
  },

  'devices.update': async ({ ctx, auth, params, body }) => {
    const [row] = await ctx.db
      .update(devices)
      .set({ name: body.name })
      .where(and(eq(devices.id, params.id), eq(devices.userId, auth.user.id), isNull(devices.revokedAt)))
      .returning();
    if (!row) throw new ApiError('not_found', 'Device not found');
    return { device: toDevice(row, auth.device?.id ?? null) };
  },

  'devices.revoke': async ({ ctx, auth, params }) => {
    if (!(await revokeDevice(ctx.db, auth.user.id, params.id))) {
      throw new ApiError('not_found', 'Device not found');
    }
  },

  'devices.createPairingCode': async ({ c, ctx, auth }) => {
    const expiresAt = new Date(Date.now() + PAIRING_CODE_TTL_SECONDS * 1000);
    let created: { id: string; code: string } | undefined;
    for (let attempt = 0; !created; attempt += 1) {
      const code = generatePairingCode();
      try {
        const [row] = await ctx.db
          .insert(pairingCodes)
          .values({ userId: auth.user.id, codeHash: hashToken(code), expiresAt })
          .returning({ id: pairingCodes.id });
        created = { id: row!.id, code };
      } catch (error) {
        if (attempt >= 3 || !isUniqueViolation(error)) throw error;
      }
    }

    const config = await getServerConfig(ctx.db);
    const addresses = effectiveAddresses(config, ctx.env);
    const origin = requestOrigin(c, ctx.env);
    const payload: PairingPayload = {
      version: 1,
      serverId: config.serverId,
      serverName: config.name,
      // Without a configured address, the one this browser used works for phones on the same
      // network, unless it's localhost. The phone can still find the server by id over Bonjour.
      homeUrl: addresses.homeUrl ?? (isLoopbackOrigin(origin) ? null : origin),
      remoteUrl: addresses.remoteUrl,
      code: created.code,
      expiresAt: expiresAt.toISOString(),
    };
    return {
      id: created.id,
      code: formatPairingCode(created.code),
      expiresAt: payload.expiresAt,
      payload,
      uri: encodePairingUri(payload),
    };
  },

  'devices.pairingCodeStatus': async ({ ctx, auth, params }) => {
    const [row] = await ctx.db
      .select({ code: pairingCodes, device: devices })
      .from(pairingCodes)
      .leftJoin(devices, eq(devices.id, pairingCodes.deviceId))
      .where(and(eq(pairingCodes.id, params.id), eq(pairingCodes.userId, auth.user.id)));
    if (!row) throw new ApiError('not_found', 'Pairing code not found');
    const status = row.code.usedAt ? 'used' : row.code.expiresAt <= new Date() ? 'expired' : 'pending';
    return {
      status,
      expiresAt: row.code.expiresAt.toISOString(),
      device: row.device && !row.device.revokedAt ? toDevice(row.device, auth.device?.id ?? null) : null,
    };
  },

  'devices.pair': async ({ c, ctx, body }) => {
    const ip = clientIp(c, ctx.env);
    enforceRateLimit(ctx.limits.ip, ip);

    let paired;
    if (body.method === 'code') {
      enforceRateLimit(ctx.limits.pairing, ip);
      paired = await ctx.db.transaction(async (tx) => {
        const now = new Date();
        const [code] = await tx
          .update(pairingCodes)
          .set({ usedAt: now })
          .where(
            and(
              eq(pairingCodes.codeHash, hashToken(body.code)),
              isNull(pairingCodes.usedAt),
              gt(pairingCodes.expiresAt, now),
            ),
          )
          .returning();
        if (!code) {
          throw new ApiError(
            'pairing_code_invalid',
            'That pairing code is wrong or has expired. Show a new QR code and try again.',
          );
        }
        const [user] = await tx.select().from(users).where(eq(users.id, code.userId));
        if (!user || user.disabledAt) {
          throw new ApiError('account_disabled', 'This account is disabled. Ask the server admin.');
        }
        const { token, device } = await createDevice(tx, { userId: user.id, info: body.device, ip });
        await tx.update(pairingCodes).set({ deviceId: device.id }).where(eq(pairingCodes.id, code.id));
        return { user, token, device };
      });
    } else {
      const loginKey = `${ip}|${body.email}`;
      enforceRateLimit(ctx.limits.login, loginKey);
      const user = await authenticate(ctx.db, body.email, body.password);
      ctx.limits.login.reset(loginKey);
      const { token, device } = await createDevice(ctx.db, { userId: user.id, info: body.device, ip });
      paired = { user, token, device };
    }

    const config = await getServerConfig(ctx.db);
    ctx.log.info({ userId: paired.user.id, deviceId: paired.device.id, method: body.method }, 'Device paired');
    return {
      deviceId: paired.device.id,
      deviceToken: paired.token,
      user: toCurrentUser(paired.user),
      server: { serverId: config.serverId, name: config.name, ...effectiveAddresses(config, ctx.env) },
    };
  },
};
