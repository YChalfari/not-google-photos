import type { MemorySummary, UpcomingMemory } from '@ngp/shared';
import { and, asc, desc, eq, gte, inArray, isNull, lte, sql } from 'drizzle-orm';
import type { AppContext } from '../context';
import { assets, memories, memoryAssets, type MemoryRow } from '../db/schema';
import { ApiError } from '../http/errors';
import type { Handlers } from '../http/contract';
import { availableVariants } from '../media/serve';
import { toSummaries } from '../media/summaries';
import { addDays, calendarDate, ensureMemories } from '../memories/on-this-day';

async function present(
  ctx: AppContext,
  userId: string,
  rows: readonly MemoryRow[],
): Promise<MemorySummary[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((row) => row.id);
  const counts = await ctx.db
    .select({ memoryId: memoryAssets.memoryId, count: sql<number>`count(*)::int` })
    .from(memoryAssets)
    .innerJoin(assets, eq(assets.id, memoryAssets.assetId))
    .where(and(inArray(memoryAssets.memoryId, ids), isNull(assets.trashedAt)))
    .groupBy(memoryAssets.memoryId);
  const countById = new Map(counts.map((row) => [row.memoryId, Number(row.count)]));
  const coverIds = rows.flatMap((row) => (row.coverAssetId ? [row.coverAssetId] : []));
  const liveCovers =
    coverIds.length === 0
      ? []
      : await ctx.db
          .select({ id: assets.id })
          .from(assets)
          .where(and(inArray(assets.id, coverIds), isNull(assets.trashedAt)));
  const live = new Set(liveCovers.map((row) => row.id));
  const variants = await availableVariants(ctx.db, [...live]);
  return rows.map((row) => {
    const coverId = row.coverAssetId && live.has(row.coverAssetId) ? row.coverAssetId : null;
    const have = coverId ? variants.get(coverId) : undefined;
    return {
      id: row.id,
      kind: row.kind,
      date: row.memoryDate,
      title: row.title,
      subtitle: row.subtitle,
      assetCount: countById.get(row.id) ?? 0,
      coverUrl:
        coverId && have?.has('thumbnail')
          ? ctx.media.sign({ assetId: coverId, variant: 'thumbnail', userId }).url
          : null,
      seenAt: row.seenAt?.toISOString() ?? null,
      dismissedAt: row.dismissedAt?.toISOString() ?? null,
    };
  });
}

async function requireMemory(ctx: AppContext, userId: string, id: string): Promise<MemoryRow> {
  const [row] = await ctx.db
    .select()
    .from(memories)
    .where(and(eq(memories.id, id), eq(memories.ownerId, userId)));
  if (!row) throw new ApiError('not_found', 'That memory is not in your library');
  return row;
}

function upcomingOf(summary: MemorySummary): UpcomingMemory {
  return {
    id: summary.id,
    date: summary.date,
    title: summary.title,
    subtitle: summary.subtitle,
    assetCount: summary.assetCount,
    coverUrl: summary.coverUrl,
  };
}

export const memoryHandlers: Handlers = {
  'memories.list': async ({ ctx, auth, query }) => {
    const today = calendarDate();
    const from = query.from ?? today;
    const to = query.to ?? today;
    await ensureMemories(ctx, auth.user.id, from, to);
    if (from > to) return { memories: [] };
    const rows = await ctx.db
      .select()
      .from(memories)
      .where(
        and(
          eq(memories.ownerId, auth.user.id),
          gte(memories.memoryDate, from),
          lte(memories.memoryDate, to),
          isNull(memories.dismissedAt),
        ),
      )
      .orderBy(desc(memories.memoryDate));
    return { memories: await present(ctx, auth.user.id, rows) };
  },

  'memories.upcoming': async ({ ctx, auth, query }) => {
    const today = calendarDate();
    const last = addDays(today, query.days - 1);
    await ensureMemories(ctx, auth.user.id, today, last);
    const rows = await ctx.db
      .select()
      .from(memories)
      .where(
        and(
          eq(memories.ownerId, auth.user.id),
          gte(memories.memoryDate, today),
          lte(memories.memoryDate, last),
          isNull(memories.dismissedAt),
        ),
      )
      .orderBy(memories.memoryDate);
    const summaries = await present(ctx, auth.user.id, rows);
    return { memories: summaries.filter((memory) => memory.assetCount > 0).map(upcomingOf) };
  },

  'memories.get': async ({ ctx, auth, params }) => {
    const row = await requireMemory(ctx, auth.user.id, params.id);
    const links = await ctx.db
      .select({ asset: assets })
      .from(memoryAssets)
      .innerJoin(assets, eq(assets.id, memoryAssets.assetId))
      .where(and(eq(memoryAssets.memoryId, row.id), isNull(assets.trashedAt)))
      .orderBy(asc(memoryAssets.position));
    const [summary] = await present(ctx, auth.user.id, [row]);
    return {
      memory: {
        ...summary!,
        assets: await toSummaries(
          ctx,
          auth.user.id,
          links.map((link) => link.asset),
        ),
      },
    };
  },

  'memories.update': async ({ ctx, auth, params, body }) => {
    const row = await requireMemory(ctx, auth.user.id, params.id);
    const patch: Partial<Pick<MemoryRow, 'seenAt' | 'dismissedAt' | 'notifiedAt'>> = {};
    if (body.seen === true && !row.seenAt) patch.seenAt = new Date();
    if (body.seen === false) patch.seenAt = null;
    if (body.dismissed === true && !row.dismissedAt) patch.dismissedAt = new Date();
    if (body.dismissed === false) patch.dismissedAt = null;
    if (body.notified === true && !row.notifiedAt) patch.notifiedAt = new Date();
    if (body.notified === false) patch.notifiedAt = null;
    const next =
      Object.keys(patch).length === 0
        ? row
        : (await ctx.db.update(memories).set(patch).where(eq(memories.id, row.id)).returning())[0]!;
    const [summary] = await present(ctx, auth.user.id, [next]);
    return { memory: summary! };
  },
};
