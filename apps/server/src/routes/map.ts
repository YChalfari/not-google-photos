import { and, desc, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import { assets } from '../db/schema';
import type { Handlers } from '../http/contract';
import { toSummaries } from '../media/summaries';

const MAP_LIMIT = 3000;

export const mapHandlers: Handlers = {
  'map.points': async ({ ctx, auth }) => {
    const rows = await ctx.db
      .select()
      .from(assets)
      .where(
        and(
          eq(assets.ownerId, auth.user.id),
          eq(assets.intake, 'library'),
          isNull(assets.trashedAt),
          isNotNull(assets.latitude),
          isNotNull(assets.longitude),
        ),
      )
      .orderBy(sql`${assets.capturedAt} desc nulls last`, desc(assets.id))
      .limit(MAP_LIMIT);
    const summaries = await toSummaries(ctx, auth.user.id, rows);
    const thumbs = new Map(summaries.map((summary) => [summary.id, summary.thumbnailUrl]));
    return {
      points: rows.flatMap((row) => {
        if (row.latitude == null || row.longitude == null) return [];
        return [
          {
            id: row.id,
            latitude: row.latitude,
            longitude: row.longitude,
            thumbnailUrl: thumbs.get(row.id) ?? null,
          },
        ];
      }),
    };
  },
};
