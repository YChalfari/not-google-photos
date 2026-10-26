import type { ServerSettings } from '@ngp/shared';
import { and, asc, count, eq, isNull, ne, sql } from 'drizzle-orm';
import { deleteUserSessions } from '../auth/sessions';
import type { AppContext } from '../context';
import { serverConfig, users } from '../db/schema';
import type { Handlers } from '../http/contract';
import { ApiError } from '../http/errors';
import {
  activeDeviceCounts,
  storageUsageByUser,
  toAdminUser,
} from '../services/accounts';
import { getServerConfig } from '../services/server-config';

async function serverSettings(ctx: AppContext): Promise<ServerSettings> {
  const [config, library] = await Promise.all([
    getServerConfig(ctx.db),
    ctx.library.status({ fresh: true }),
  ]);
  return {
    serverId: config.serverId,
    name: config.name,
    version: ctx.version,
    homeUrl: config.homeUrl,
    remoteUrl: config.remoteUrl,
    defaults: { homeUrl: ctx.env.HOME_URL ?? null, remoteUrl: ctx.env.REMOTE_URL ?? null },
    library,
  };
}

export const adminHandlers: Handlers = {
  'admin.users.list': async ({ ctx }) => {
    const [rows, deviceCounts, usage] = await Promise.all([
      ctx.db.select().from(users).orderBy(asc(users.createdAt)),
      activeDeviceCounts(ctx.db),
      storageUsageByUser(ctx.db),
    ]);
    return {
      users: rows.map((user) => toAdminUser(user, deviceCounts.get(user.id) ?? 0, usage.get(user.id))),
    };
  },

  'admin.users.update': async ({ ctx, params, body }) => {
    const updated = await ctx.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('ngp:admins'))`);
      const [target] = await tx.select().from(users).where(eq(users.id, params.id)).for('update');
      if (!target) throw new ApiError('not_found', 'User not found');

      const isActiveAdmin = target.role === 'admin' && !target.disabledAt;
      const losesAdmin = (body.role !== undefined && body.role !== 'admin') || body.disabled === true;
      if (isActiveAdmin && losesAdmin) {
        const [others] = await tx
          .select({ value: count() })
          .from(users)
          .where(and(eq(users.role, 'admin'), isNull(users.disabledAt), ne(users.id, target.id)));
        if (!others?.value) {
          throw new ApiError('conflict', 'This is the last active admin. Make someone else an admin first.');
        }
      }

      const [row] = await tx
        .update(users)
        .set({
          ...(body.name === undefined ? {} : { name: body.name }),
          ...(body.role === undefined ? {} : { role: body.role }),
          ...(body.quotaBytes === undefined ? {} : { quotaBytes: body.quotaBytes }),
          ...(body.disabled === undefined
            ? {}
            : { disabledAt: body.disabled ? (target.disabledAt ?? new Date()) : null }),
        })
        .where(eq(users.id, target.id))
        .returning();
      if (body.disabled) await deleteUserSessions(tx, target.id);
      return row!;
    });
    const [deviceCounts, usage] = await Promise.all([
      activeDeviceCounts(ctx.db),
      storageUsageByUser(ctx.db, [updated.id]),
    ]);
    return { user: toAdminUser(updated, deviceCounts.get(updated.id) ?? 0, usage.get(updated.id)) };
  },

  'admin.server.get': async ({ ctx }) => serverSettings(ctx),

  'admin.server.update': async ({ ctx, body }) => {
    const changes = {
      ...(body.name === undefined ? {} : { name: body.name }),
      ...(body.homeUrl === undefined ? {} : { homeUrl: body.homeUrl }),
      ...(body.remoteUrl === undefined ? {} : { remoteUrl: body.remoteUrl }),
    };
    if (Object.keys(changes).length > 0) {
      await ctx.db.update(serverConfig).set(changes).where(eq(serverConfig.id, 1));
    }
    return serverSettings(ctx);
  },

  'users.directory': async ({ ctx, auth }) => ({
    users: await ctx.db
      .select({ id: users.id, name: users.name })
      .from(users)
      .where(and(isNull(users.disabledAt), ne(users.id, auth.user.id)))
      .orderBy(asc(users.name)),
  }),
};
