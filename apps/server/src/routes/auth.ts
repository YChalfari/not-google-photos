import { eq, sql } from 'drizzle-orm';
import { revokeDevice } from '../auth/devices';
import { hashPassword, verifyPassword } from '../auth/passwords';
import { deleteSession, deleteUserSessions } from '../auth/sessions';
import { serverConfig, users } from '../db/schema';
import { clientIp } from '../http/client';
import type { Handlers } from '../http/contract';
import { clearSessionCookie } from '../http/cookies';
import { ApiError, isUniqueViolation } from '../http/errors';
import { enforceRateLimit } from '../http/rate-limit';
import {
  authenticate,
  countUsers,
  startSession,
  storageUsageFor,
  toCurrentUser,
} from '../services/accounts';

export const authHandlers: Handlers = {
  'setup.complete': async ({ c, ctx, body }) => {
    enforceRateLimit(ctx.limits.ip, clientIp(c, ctx.env));
    if ((await countUsers(ctx.db)) > 0) {
      throw new ApiError('setup_already_done', 'This server is already set up. Sign in instead.');
    }
    const passwordHash = await hashPassword(body.password);
    const user = await ctx.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('ngp:setup'))`);
      if ((await countUsers(tx)) > 0) {
        throw new ApiError('setup_already_done', 'This server is already set up. Sign in instead.');
      }
      const [created] = await tx
        .insert(users)
        .values({
          email: body.email,
          name: body.name,
          passwordHash,
          role: 'admin',
          lastLoginAt: new Date(),
        })
        .returning();
      if (body.serverName) {
        await tx.update(serverConfig).set({ name: body.serverName }).where(eq(serverConfig.id, 1));
      }
      return created!;
    });
    await startSession(c, ctx, user.id);
    ctx.log.info({ userId: user.id }, 'First-run setup complete');
    return { user: toCurrentUser(user) };
  },

  'auth.login': async ({ c, ctx, body }) => {
    const ip = clientIp(c, ctx.env);
    const loginKey = `${ip}|${body.email}`;
    enforceRateLimit(ctx.limits.ip, ip);
    enforceRateLimit(ctx.limits.login, loginKey);
    const user = await authenticate(ctx.db, body.email, body.password);
    ctx.limits.login.reset(loginKey);
    await ctx.db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, user.id));
    await startSession(c, ctx, user.id);
    return { user: toCurrentUser(user) };
  },

  'auth.logout': async ({ c, ctx, auth }) => {
    if (auth.kind === 'session') {
      await deleteSession(ctx.db, auth.session.id);
      clearSessionCookie(c, ctx.env);
    } else {
      await revokeDevice(ctx.db, auth.user.id, auth.device.id);
    }
  },

  'auth.me': ({ auth }) => ({
    user: toCurrentUser(auth.user),
    via: auth.kind,
    deviceId: auth.device?.id ?? null,
  }),

  'auth.changePassword': async ({ ctx, auth, body }) => {
    enforceRateLimit(ctx.limits.login, `password|${auth.user.id}`);
    if (!(await verifyPassword(body.currentPassword, auth.user.passwordHash))) {
      throw new ApiError('invalid_credentials', 'Your current password is incorrect');
    }
    const passwordHash = await hashPassword(body.newPassword);
    await ctx.db.update(users).set({ passwordHash }).where(eq(users.id, auth.user.id));
    await deleteUserSessions(ctx.db, auth.user.id, { exceptSessionId: auth.session?.id });
    ctx.limits.login.reset(`password|${auth.user.id}`);
  },

  'me.update': async ({ ctx, auth, body }) => {
    try {
      const [user] = await ctx.db
        .update(users)
        .set({
          ...(body.name === undefined ? {} : { name: body.name }),
          ...(body.email === undefined ? {} : { email: body.email }),
        })
        .where(eq(users.id, auth.user.id))
        .returning();
      return { user: toCurrentUser(user!) };
    } catch (error) {
      if (isUniqueViolation(error, 'users_email_key')) {
        throw new ApiError('conflict', 'Another account already uses that email');
      }
      throw error;
    }
  },

  'me.storage': async ({ ctx, auth }) => storageUsageFor(ctx.db, auth.user),
};
