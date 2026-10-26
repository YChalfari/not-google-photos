import { TOKEN_PREFIX, type Invite, type InviteStatus } from '@ngp/shared';
import { desc, eq } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { hashPassword } from '../auth/passwords';
import { generateToken, hashToken } from '../auth/tokens';
import type { DbOrTx } from '../db/client';
import { invites, users, type InviteRow } from '../db/schema';
import { clientIp, requestOrigin } from '../http/client';
import type { Handlers } from '../http/contract';
import { ApiError, isUniqueViolation } from '../http/errors';
import { enforceRateLimit } from '../http/rate-limit';
import { findUserByEmail, startSession, toCurrentUser } from '../services/accounts';
import { effectiveAddresses, getServerConfig } from '../services/server-config';

const DAY_MS = 86_400_000;

export function inviteStatus(invite: InviteRow, now = new Date()): InviteStatus {
  if (invite.acceptedAt) return 'accepted';
  if (invite.revokedAt) return 'revoked';
  if (invite.expiresAt <= now) return 'expired';
  return 'pending';
}

type UserRef = { id: string; name: string } | null;

function toInvite(invite: InviteRow, createdBy: UserRef, acceptedBy: UserRef): Invite {
  return {
    id: invite.id,
    email: invite.email,
    name: invite.name,
    role: invite.role,
    quotaBytes: invite.quotaBytes,
    status: inviteStatus(invite),
    createdAt: invite.createdAt.toISOString(),
    expiresAt: invite.expiresAt.toISOString(),
    createdBy,
    acceptedBy,
    acceptedAt: invite.acceptedAt?.toISOString() ?? null,
  };
}

const inviteInvalid = () =>
  new ApiError('invite_invalid', 'This invite link is no longer valid. Ask for a new one.');

async function findPendingInvite(db: DbOrTx, token: string) {
  const creator = alias(users, 'creator');
  const [row] = await db
    .select({ invite: invites, invitedBy: creator.name })
    .from(invites)
    .leftJoin(creator, eq(creator.id, invites.createdById))
    .where(eq(invites.tokenHash, hashToken(token)));
  if (!row || inviteStatus(row.invite) !== 'pending') throw inviteInvalid();
  return row;
}

export const inviteHandlers: Handlers = {
  'invites.list': async ({ ctx }) => {
    const creator = alias(users, 'creator');
    const acceptor = alias(users, 'acceptor');
    const rows = await ctx.db
      .select({
        invite: invites,
        creatorId: creator.id,
        creatorName: creator.name,
        acceptorId: acceptor.id,
        acceptorName: acceptor.name,
      })
      .from(invites)
      .leftJoin(creator, eq(creator.id, invites.createdById))
      .leftJoin(acceptor, eq(acceptor.id, invites.acceptedById))
      .orderBy(desc(invites.createdAt));
    return {
      invites: rows.map((row) =>
        toInvite(
          row.invite,
          row.creatorId ? { id: row.creatorId, name: row.creatorName ?? '' } : null,
          row.acceptorId ? { id: row.acceptorId, name: row.acceptorName ?? '' } : null,
        ),
      ),
    };
  },

  'invites.create': async ({ c, ctx, auth, body }) => {
    if (body.email && (await findUserByEmail(ctx.db, body.email))) {
      throw new ApiError('conflict', `${body.email} already has an account on this server`);
    }
    const token = generateToken(TOKEN_PREFIX.invite);
    const [invite] = await ctx.db
      .insert(invites)
      .values({
        tokenHash: hashToken(token),
        email: body.email ?? null,
        name: body.name ?? null,
        role: body.role,
        quotaBytes: body.quotaBytes,
        createdById: auth.user.id,
        expiresAt: new Date(Date.now() + body.expiresInDays * DAY_MS),
      })
      .returning();
    const { homeUrl, remoteUrl } = effectiveAddresses(await getServerConfig(ctx.db), ctx.env);
    const path = `/invite/${token}`;
    return {
      invite: toInvite(invite!, { id: auth.user.id, name: auth.user.name }, null),
      token,
      path,
      url: `${remoteUrl ?? homeUrl ?? requestOrigin(c, ctx.env)}${path}`,
    };
  },

  'invites.revoke': async ({ ctx, params }) => {
    const [invite] = await ctx.db.select().from(invites).where(eq(invites.id, params.id));
    if (!invite) throw new ApiError('not_found', 'Invite not found');
    if (invite.acceptedAt) throw new ApiError('conflict', 'This invite was already accepted');
    if (!invite.revokedAt) {
      await ctx.db.update(invites).set({ revokedAt: new Date() }).where(eq(invites.id, invite.id));
    }
  },

  'invites.lookup': async ({ c, ctx, body }) => {
    enforceRateLimit(ctx.limits.invites, clientIp(c, ctx.env));
    const { invite, invitedBy } = await findPendingInvite(ctx.db, body.token);
    const config = await getServerConfig(ctx.db);
    return {
      serverName: config.name,
      invite: {
        email: invite.email,
        name: invite.name,
        role: invite.role,
        expiresAt: invite.expiresAt.toISOString(),
        invitedBy,
      },
    };
  },

  'invites.accept': async ({ c, ctx, body }) => {
    enforceRateLimit(ctx.limits.invites, clientIp(c, ctx.env));
    const { invite: preview } = await findPendingInvite(ctx.db, body.token);
    if (preview.email && preview.email !== body.email) {
      const message = `This invite is for ${preview.email}`;
      throw new ApiError('validation_failed', message, {
        details: { issues: [{ in: 'body', path: 'email', message }] },
      });
    }
    const passwordHash = await hashPassword(body.password);
    const conflict = () =>
      new ApiError('conflict', 'An account with this email already exists. Sign in instead.');

    try {
      const user = await ctx.db.transaction(async (tx) => {
        const [invite] = await tx.select().from(invites).where(eq(invites.id, preview.id)).for('update');
        if (!invite || inviteStatus(invite) !== 'pending') throw inviteInvalid();
        if (await findUserByEmail(tx, body.email)) throw conflict();
        const now = new Date();
        const [created] = await tx
          .insert(users)
          .values({
            email: body.email,
            name: body.name,
            passwordHash,
            role: invite.role,
            quotaBytes: invite.quotaBytes,
            invitedById: invite.createdById,
            lastLoginAt: now,
          })
          .returning();
        await tx
          .update(invites)
          .set({ acceptedAt: now, acceptedById: created!.id })
          .where(eq(invites.id, invite.id));
        return created!;
      });
      await startSession(c, ctx, user.id);
      ctx.log.info({ userId: user.id, inviteId: preview.id }, 'Invite accepted');
      return { user: toCurrentUser(user) };
    } catch (error) {
      if (isUniqueViolation(error, 'users_email_key')) throw conflict();
      throw error;
    }
  },
};
