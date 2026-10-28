import type { AlbumDetail, AlbumSummary } from '@ngp/shared';
import { and, desc, eq, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import { canViewAlbum, filterOwnedAssetIds } from '../authz/access';
import type { AppContext } from '../context';
import type { DbOrTx } from '../db/client';
import {
  albumAssets,
  albumMembers,
  albumRules,
  albums,
  assets,
  people,
  users,
  type AlbumRow,
} from '../db/schema';
import { ApiError } from '../http/errors';
import type { Handlers } from '../http/contract';
import { availableVariants } from '../media/serve';
import { toSummaries } from '../media/summaries';

type AlbumMember = AlbumDetail['members'][number];
type AlbumRule = AlbumDetail['rules'][number];

interface Viewer {
  isOwner: boolean;
  role: AlbumSummary['role'];
  invited: boolean;
  showInTimeline: boolean;
  accepted: boolean;
  canContribute: boolean;
}

function pageOffset(cursor: string | undefined): number {
  if (!cursor) return 0;
  const value = Number(cursor);
  return Number.isInteger(value) && value >= 0 ? value : 0;
}

function viewerFrom(
  userId: string,
  ownerId: string,
  member: {
    role: 'viewer' | 'contributor';
    acceptedAt: Date | null;
    showInTimeline: boolean;
  } | null,
): Viewer | null {
  const isOwner = ownerId === userId;
  if (!isOwner && !member) return null;
  const accepted = isOwner || member?.acceptedAt != null;
  const role: AlbumSummary['role'] = isOwner ? 'owner' : member!.role;
  return {
    isOwner,
    role,
    invited: !isOwner && member?.acceptedAt == null,
    showInTimeline: isOwner ? true : Boolean(member?.showInTimeline),
    accepted,
    canContribute: isOwner || (member?.role === 'contributor' && member.acceptedAt != null),
  };
}

async function assetCounts(db: DbOrTx, albumIds: readonly string[]): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  if (albumIds.length === 0) return counts;
  const rows = await db
    .select({ albumId: albumAssets.albumId, count: sql<number>`count(*)::int` })
    .from(albumAssets)
    .innerJoin(assets, eq(assets.id, albumAssets.assetId))
    .where(and(inArray(albumAssets.albumId, [...albumIds]), isNull(assets.trashedAt)))
    .groupBy(albumAssets.albumId);
  for (const row of rows) counts.set(row.albumId, Number(row.count));
  return counts;
}

async function coverUrls(
  ctx: AppContext,
  userId: string,
  rows: readonly { id: string; coverAssetId: string | null }[],
): Promise<Map<string, string | null>> {
  const urls = new Map<string, string | null>();
  if (rows.length === 0) return urls;
  const explicitIds = rows.flatMap((row) => (row.coverAssetId ? [row.coverAssetId] : []));
  const liveExplicit =
    explicitIds.length === 0
      ? []
      : await ctx.db
          .select({ id: assets.id })
          .from(assets)
          .where(and(inArray(assets.id, explicitIds), isNull(assets.trashedAt)));
  const live = new Set(liveExplicit.map((row) => row.id));
  const fallback = await ctx.db
    .selectDistinctOn([albumAssets.albumId], {
      albumId: albumAssets.albumId,
      assetId: albumAssets.assetId,
    })
    .from(albumAssets)
    .innerJoin(assets, eq(assets.id, albumAssets.assetId))
    .where(
      and(
        inArray(
          albumAssets.albumId,
          rows.map((row) => row.id),
        ),
        isNull(assets.trashedAt),
      ),
    )
    .orderBy(albumAssets.albumId, desc(albumAssets.addedAt));
  const fallbackByAlbum = new Map(fallback.map((row) => [row.albumId, row.assetId]));
  const chosen = new Map<string, string | null>();
  for (const row of rows) {
    const cover =
      row.coverAssetId && live.has(row.coverAssetId)
        ? row.coverAssetId
        : (fallbackByAlbum.get(row.id) ?? null);
    chosen.set(row.id, cover);
  }
  const variants = await availableVariants(
    ctx.db,
    [...chosen.values()].filter((id): id is string => id !== null),
  );
  for (const [albumId, assetId] of chosen) {
    const have = assetId ? variants.get(assetId) : undefined;
    urls.set(
      albumId,
      assetId && have?.has('thumbnail')
        ? ctx.media.sign({ assetId, variant: 'thumbnail', userId }).url
        : null,
    );
  }
  return urls;
}

function toSummary(
  album: AlbumRow,
  owner: { id: string; name: string },
  view: Viewer,
  assetCount: number,
  coverUrl: string | null,
): AlbumSummary {
  return {
    id: album.id,
    title: album.title,
    owner,
    assetCount,
    coverUrl,
    isLive: album.isLive,
    role: view.role,
    invited: view.invited,
    showInTimeline: view.showInTimeline,
    updatedAt: album.updatedAt.toISOString(),
  };
}

async function loadAlbum(ctx: AppContext, userId: string, albumId: string) {
  const [row] = await ctx.db
    .select({
      album: albums,
      ownerId: users.id,
      ownerName: users.name,
      memberRole: albumMembers.role,
      acceptedAt: albumMembers.acceptedAt,
      showInTimeline: albumMembers.showInTimeline,
    })
    .from(albums)
    .innerJoin(users, eq(users.id, albums.ownerId))
    .leftJoin(
      albumMembers,
      and(eq(albumMembers.albumId, albums.id), eq(albumMembers.userId, userId)),
    )
    .where(eq(albums.id, albumId));
  if (!row) return null;
  const member =
    row.memberRole == null
      ? null
      : {
          role: row.memberRole,
          acceptedAt: row.acceptedAt,
          showInTimeline: row.showInTimeline ?? false,
        };
  const view = viewerFrom(userId, row.album.ownerId, member);
  if (!view) return null;
  return { album: row.album, owner: { id: row.ownerId, name: row.ownerName }, view };
}

async function albumDetail(ctx: AppContext, userId: string, albumId: string): Promise<AlbumDetail> {
  const loaded = await loadAlbum(ctx, userId, albumId);
  if (!loaded) throw new ApiError('not_found', 'That album is not in your library');
  const { album, owner, view } = loaded;
  const [counts, covers, memberRows, ruleRows] = await Promise.all([
    assetCounts(ctx.db, [album.id]),
    coverUrls(ctx, userId, [album]),
    ctx.db
      .select({
        userId: users.id,
        name: users.name,
        role: albumMembers.role,
        acceptedAt: albumMembers.acceptedAt,
        showInTimeline: albumMembers.showInTimeline,
      })
      .from(albumMembers)
      .innerJoin(users, eq(users.id, albumMembers.userId))
      .where(eq(albumMembers.albumId, album.id))
      .orderBy(users.name),
    view.accepted
      ? ctx.db
          .select({
            id: albumRules.id,
            userId: albumRules.userId,
            personId: people.id,
            personName: people.name,
            startDate: albumRules.startDate,
          })
          .from(albumRules)
          .innerJoin(people, eq(people.id, albumRules.personId))
          .where(eq(albumRules.albumId, album.id))
      : Promise.resolve([]),
  ]);
  const members: AlbumMember[] = memberRows.map((member) => ({
    user: { id: member.userId, name: member.name },
    role: member.role,
    status: member.acceptedAt ? 'joined' : 'invited',
    showInTimeline: member.showInTimeline,
  }));
  const rules: AlbumRule[] = ruleRows.map((rule) => ({
    id: rule.id,
    userId: rule.userId,
    person: { id: rule.personId, name: rule.personName },
    startDate: rule.startDate,
  }));
  return {
    ...toSummary(album, owner, view, counts.get(album.id) ?? 0, covers.get(album.id) ?? null),
    description: album.description,
    members,
    rules,
  };
}

async function requireAlbum(ctx: AppContext, userId: string, albumId: string) {
  const loaded = await loadAlbum(ctx, userId, albumId);
  if (!loaded) throw new ApiError('not_found', 'That album is not in your library');
  return loaded;
}

/** Adds the caller's own, non-trashed photos. Duplicates are skipped. */
async function insertOwnedAssets(
  db: DbOrTx,
  userId: string,
  albumId: string,
  assetIds: readonly string[],
): Promise<number> {
  const owned = await filterOwnedAssetIds(db, userId, assetIds);
  if (owned.size === 0) return 0;
  const live = await db
    .select({ id: assets.id })
    .from(assets)
    .where(and(inArray(assets.id, [...owned]), isNull(assets.trashedAt)));
  if (live.length === 0) return 0;
  const inserted = await db
    .insert(albumAssets)
    .values(
      live.map((row) => ({
        albumId,
        assetId: row.id,
        addedById: userId,
        source: 'manual' as const,
      })),
    )
    .onConflictDoNothing()
    .returning({ assetId: albumAssets.assetId });
  if (inserted.length > 0) {
    const [album] = await db
      .select({ coverAssetId: albums.coverAssetId })
      .from(albums)
      .where(eq(albums.id, albumId));
    await db
      .update(albums)
      .set({
        updatedAt: new Date(),
        ...(album?.coverAssetId ? {} : { coverAssetId: inserted[0]!.assetId }),
      })
      .where(eq(albums.id, albumId));
  }
  return inserted.length;
}

export const albumHandlers: Handlers = {
  'albums.list': async ({ ctx, auth, query }) => {
    const userId = auth.user.id;
    const scope = query.scope;
    const rows = await ctx.db
      .select({
        album: albums,
        ownerId: users.id,
        ownerName: users.name,
        memberRole: albumMembers.role,
        acceptedAt: albumMembers.acceptedAt,
        showInTimeline: albumMembers.showInTimeline,
      })
      .from(albums)
      .innerJoin(users, eq(users.id, albums.ownerId))
      .leftJoin(
        albumMembers,
        and(eq(albumMembers.albumId, albums.id), eq(albumMembers.userId, userId)),
      )
      .where(
        scope === 'owned'
          ? eq(albums.ownerId, userId)
          : scope === 'shared'
            ? and(sql`${albumMembers.userId} is not null`, ne(albums.ownerId, userId))
            : or(eq(albums.ownerId, userId), sql`${albumMembers.userId} is not null`),
      )
      .orderBy(desc(albums.updatedAt));
    const counts = await assetCounts(
      ctx.db,
      rows.map((row) => row.album.id),
    );
    const covers = await coverUrls(
      ctx,
      userId,
      rows.map((row) => row.album),
    );
    const summaries: AlbumSummary[] = [];
    for (const row of rows) {
      const member =
        row.memberRole == null
          ? null
          : {
              role: row.memberRole,
              acceptedAt: row.acceptedAt,
              showInTimeline: row.showInTimeline ?? false,
            };
      const view = viewerFrom(userId, row.album.ownerId, member);
      if (!view) continue;
      summaries.push(
        toSummary(
          row.album,
          { id: row.ownerId, name: row.ownerName },
          view,
          counts.get(row.album.id) ?? 0,
          covers.get(row.album.id) ?? null,
        ),
      );
    }
    return { albums: summaries };
  },

  'albums.create': async ({ ctx, auth, body }) => {
    const created = await ctx.db.transaction(async (tx) => {
      const [album] = await tx
        .insert(albums)
        .values({
          ownerId: auth.user.id,
          title: body.title,
          description: body.description ?? null,
        })
        .returning();
      if (body.assetIds && body.assetIds.length > 0) {
        await insertOwnedAssets(tx, auth.user.id, album!.id, body.assetIds);
      }
      return album!;
    });
    return { album: await albumDetail(ctx, auth.user.id, created.id) };
  },

  'albums.get': async ({ ctx, auth, params }) => ({
    album: await albumDetail(ctx, auth.user.id, params.id),
  }),

  'albums.update': async ({ ctx, auth, params, body }) => {
    const { album, view } = await requireAlbum(ctx, auth.user.id, params.id);
    if (!view.isOwner) throw new ApiError('forbidden', 'Only the owner can edit this album');
    const changes: { title?: string; description?: string | null; coverAssetId?: string | null } =
      {};
    if (body.title !== undefined) changes.title = body.title;
    if (body.description !== undefined) changes.description = body.description;
    if (body.coverAssetId !== undefined) {
      if (body.coverAssetId !== null) {
        const [inAlbum] = await ctx.db
          .select({ assetId: albumAssets.assetId })
          .from(albumAssets)
          .where(
            and(eq(albumAssets.albumId, album.id), eq(albumAssets.assetId, body.coverAssetId)),
          );
        if (!inAlbum) throw new ApiError('bad_request', 'Choose a photo from this album');
      }
      changes.coverAssetId = body.coverAssetId;
    }
    if (Object.keys(changes).length > 0) {
      await ctx.db.update(albums).set(changes).where(eq(albums.id, album.id));
    }
    return { album: await albumDetail(ctx, auth.user.id, album.id) };
  },

  'albums.delete': async ({ ctx, auth, params }) => {
    const { album, view } = await requireAlbum(ctx, auth.user.id, params.id);
    if (!view.isOwner) throw new ApiError('forbidden', 'Only the owner can delete this album');
    await ctx.db.delete(albums).where(eq(albums.id, album.id));
  },

  'albums.assets': async ({ ctx, auth, params, query }) => {
    const { album, view } = await requireAlbum(ctx, auth.user.id, params.id);
    if (!view.accepted) throw new ApiError('not_found', 'That album is not in your library');
    if (!(await canViewAlbum(ctx.db, auth.user.id, album.id))) {
      throw new ApiError('not_found', 'That album is not in your library');
    }
    const offset = pageOffset(query.cursor);
    const rows = await ctx.db
      .select({ asset: assets })
      .from(albumAssets)
      .innerJoin(assets, eq(assets.id, albumAssets.assetId))
      .where(and(eq(albumAssets.albumId, album.id), isNull(assets.trashedAt)))
      .orderBy(sql`${assets.capturedAt} desc nulls last`, desc(assets.id))
      .offset(offset)
      .limit(query.limit + 1);
    const page = rows.slice(0, query.limit);
    return {
      items: await toSummaries(
        ctx,
        auth.user.id,
        page.map((row) => row.asset),
      ),
      nextCursor: rows.length > query.limit ? String(offset + query.limit) : null,
    };
  },

  'albums.addAssets': async ({ ctx, auth, params, body }) => {
    const { album, view } = await requireAlbum(ctx, auth.user.id, params.id);
    if (!view.accepted) throw new ApiError('not_found', 'That album is not in your library');
    if (!view.canContribute) {
      throw new ApiError('forbidden', 'You can view this album, but not add to it');
    }
    const added = await insertOwnedAssets(ctx.db, auth.user.id, album.id, body.assetIds);
    return { added };
  },

  'albums.removeAssets': async ({ ctx, auth, params, body }) => {
    const { album, view } = await requireAlbum(ctx, auth.user.id, params.id);
    if (!view.accepted) throw new ApiError('not_found', 'That album is not in your library');
    if (!view.isOwner && !view.canContribute) {
      throw new ApiError('forbidden', 'You cannot remove photos from this album');
    }
    const ids = [...new Set(body.assetIds)];
    const removed = await ctx.db
      .delete(albumAssets)
      .where(
        and(
          eq(albumAssets.albumId, album.id),
          inArray(albumAssets.assetId, ids),
          view.isOwner ? sql`true` : eq(albumAssets.addedById, auth.user.id),
        ),
      )
      .returning({ assetId: albumAssets.assetId });
    if (removed.length > 0) {
      await ctx.db.update(albums).set({ updatedAt: new Date() }).where(eq(albums.id, album.id));
    }
    return { removed: removed.length };
  },

  'albums.join': async ({ ctx, auth, params }) => {
    const { album, view } = await requireAlbum(ctx, auth.user.id, params.id);
    if (view.isOwner || !view.invited) {
      if (view.accepted) return { album: await albumDetail(ctx, auth.user.id, album.id) };
      throw new ApiError('not_found', 'There is no invitation for you');
    }
    await ctx.db
      .update(albumMembers)
      .set({ acceptedAt: new Date() })
      .where(and(eq(albumMembers.albumId, album.id), eq(albumMembers.userId, auth.user.id)));
    return { album: await albumDetail(ctx, auth.user.id, album.id) };
  },

  'albums.members.add': async ({ ctx, auth, params, body }) => {
    const { album, view } = await requireAlbum(ctx, auth.user.id, params.id);
    if (!view.isOwner) throw new ApiError('forbidden', 'Only the owner can invite people');
    const [person] = await ctx.db
      .select({ id: users.id, name: users.name, disabledAt: users.disabledAt })
      .from(users)
      .where(eq(users.id, body.userId));
    if (!person || person.disabledAt) {
      throw new ApiError('not_found', 'That person is not on this server');
    }
    if (person.id === album.ownerId) {
      throw new ApiError('conflict', 'The owner is already part of this album');
    }
    const [existing] = await ctx.db
      .select({ userId: albumMembers.userId })
      .from(albumMembers)
      .where(and(eq(albumMembers.albumId, album.id), eq(albumMembers.userId, person.id)));
    if (existing) throw new ApiError('conflict', 'That person is already invited');
    const [member] = await ctx.db
      .insert(albumMembers)
      .values({
        albumId: album.id,
        userId: person.id,
        role: body.role,
        showInTimeline: false,
        invitedById: auth.user.id,
      })
      .returning();
    await ctx.db.update(albums).set({ updatedAt: new Date() }).where(eq(albums.id, album.id));
    return {
      member: {
        user: { id: person.id, name: person.name },
        role: member!.role,
        status: 'invited' as const,
        showInTimeline: member!.showInTimeline,
      },
    };
  },

  'albums.members.update': async ({ ctx, auth, params, body }) => {
    const { album, view } = await requireAlbum(ctx, auth.user.id, params.id);
    const [target] = await ctx.db
      .select({
        userId: users.id,
        name: users.name,
        role: albumMembers.role,
        acceptedAt: albumMembers.acceptedAt,
        showInTimeline: albumMembers.showInTimeline,
      })
      .from(albumMembers)
      .innerJoin(users, eq(users.id, albumMembers.userId))
      .where(and(eq(albumMembers.albumId, album.id), eq(albumMembers.userId, params.userId)));
    if (!target) throw new ApiError('not_found', 'That person is not in this album');
    if (body.role !== undefined && !view.isOwner) {
      throw new ApiError('forbidden', 'Only the owner can change roles');
    }
    if (body.showInTimeline !== undefined && params.userId !== auth.user.id) {
      throw new ApiError('forbidden', 'Each person chooses their own timeline');
    }
    if (body.showInTimeline !== undefined && target.acceptedAt == null) {
      throw new ApiError('forbidden', 'Join the album before changing this');
    }
    const [updated] = await ctx.db
      .update(albumMembers)
      .set({
        ...(body.role !== undefined ? { role: body.role } : {}),
        ...(body.showInTimeline !== undefined ? { showInTimeline: body.showInTimeline } : {}),
      })
      .where(and(eq(albumMembers.albumId, album.id), eq(albumMembers.userId, target.userId)))
      .returning();
    return {
      member: {
        user: { id: target.userId, name: target.name },
        role: updated!.role,
        status: updated!.acceptedAt ? ('joined' as const) : ('invited' as const),
        showInTimeline: updated!.showInTimeline,
      },
    };
  },

  'albums.members.remove': async ({ ctx, auth, params }) => {
    const { album, view } = await requireAlbum(ctx, auth.user.id, params.id);
    const removingSelf = params.userId === auth.user.id;
    if (!removingSelf && !view.isOwner) {
      throw new ApiError('forbidden', 'Only the owner can remove someone else');
    }
    const removed = await ctx.db
      .delete(albumMembers)
      .where(and(eq(albumMembers.albumId, album.id), eq(albumMembers.userId, params.userId)))
      .returning({ userId: albumMembers.userId });
    if (removed.length === 0) throw new ApiError('not_found', 'That person is not in this album');
  },
};
