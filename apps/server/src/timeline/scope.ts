import { and, eq, isNotNull, isNull, or, sql, type SQL } from 'drizzle-orm';
import { assets } from '../db/schema';

export type TimelineScopeName = 'library' | 'favorites' | 'archive' | 'trash';

export interface TimelineFilter {
  scope: TimelineScopeName;
  withShared: boolean;
}

/**
 * Month key in the photo's own calendar, not UTC. Photos with no capture date fall into the
 * month they were uploaded, so they still show up.
 */
export const timelineMonth = sql<string>`to_char(coalesce(${assets.localDate}, (${assets.createdAt} at time zone 'UTC')::date), 'YYYY-MM')`;

function ownScope(scope: TimelineScopeName): SQL {
  switch (scope) {
    case 'library':
      return and(isNull(assets.trashedAt), eq(assets.isArchived, false))!;
    case 'favorites':
      return and(
        isNull(assets.trashedAt),
        eq(assets.isArchived, false),
        eq(assets.isFavorite, true),
      )!;
    case 'archive':
      return and(isNull(assets.trashedAt), eq(assets.isArchived, true))!;
    case 'trash':
      return isNotNull(assets.trashedAt);
  }
}

/**
 * Whose photos appear. Archive and trash are private. Shared albums join the library and
 * favorites only when that member turned "show in my timeline" on.
 */
export function timelineWhere(userId: string, filter: TimelineFilter): SQL {
  const own = and(eq(assets.ownerId, userId), ownScope(filter.scope))!;
  if (!filter.withShared || filter.scope === 'archive' || filter.scope === 'trash') return own;
  const shared = and(
    sql`${assets.ownerId} <> ${userId}`,
    isNull(assets.trashedAt),
    eq(assets.isArchived, false),
    filter.scope === 'favorites' ? eq(assets.isFavorite, true) : undefined,
    sql`exists (
      select 1 from album_assets authz_aa
      join album_members authz_am on authz_am.album_id = authz_aa.album_id
      where authz_aa.asset_id = ${assets.id}
        and authz_am.user_id = ${userId}
        and authz_am.accepted_at is not null
        and authz_am.show_in_timeline
    )`,
  );
  return or(own, shared)!;
}
