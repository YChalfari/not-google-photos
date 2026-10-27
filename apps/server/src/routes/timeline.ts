import { and, desc, sql } from 'drizzle-orm';
import { assets } from '../db/schema';
import type { Handlers } from '../http/contract';
import { toSummaries } from '../media/summaries';
import { timelineMonth, timelineWhere } from '../timeline/scope';

export const timelineHandlers: Handlers = {
  'timeline.buckets': async ({ ctx, auth, query }) => {
    const rows = await ctx.db
      .select({ key: timelineMonth, count: sql<number>`count(*)::int` })
      .from(assets)
      .where(timelineWhere(auth.user.id, query))
      .groupBy(timelineMonth)
      .orderBy(desc(timelineMonth));
    return { buckets: rows.map((row) => ({ key: row.key, count: Number(row.count) })) };
  },

  'timeline.bucket': async ({ ctx, auth, params, query }) => {
    const rows = await ctx.db
      .select()
      .from(assets)
      .where(and(timelineWhere(auth.user.id, query), sql`${timelineMonth} = ${params.key}`))
      .orderBy(sql`${assets.capturedAt} desc nulls last`, desc(assets.id));
    return { assets: await toSummaries(ctx, auth.user.id, rows) };
  },
};
