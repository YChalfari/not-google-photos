import type { MediaVariant } from '@ngp/shared';
import { and, desc, eq, gte, ilike, inArray, isNotNull, isNull, lte, or, sql, type SQL } from 'drizzle-orm';
import { assetTags, assets, people, tags } from '../db/schema';
import type { Handlers } from '../http/contract';
import { availableVariants } from '../media/serve';
import { toSummaries } from '../media/summaries';
import { personSummaries } from '../people/library';
import { similarAssetIds } from '../search/similar';
import { slugsInText, splitQuery } from '../search/text';

function pageOffset(cursor: string | undefined): number {
  if (!cursor) return 0;
  const value = Number(cursor);
  return Number.isInteger(value) && value >= 0 ? value : 0;
}

function hasPeople(personIds: readonly string[]): SQL {
  const list = sql.join(
    personIds.map((id) => sql`${id}`),
    sql`, `,
  );
  return sql`exists (
    select 1 from faces
    where faces.asset_id = ${assets.id}
      and faces.ignored = false
      and faces.person_id in (${list})
  )`;
}

function hasEveryPerson(personIds: readonly string[]): SQL {
  return sql.join(
    personIds.map(
      (id) => sql`exists (
        select 1 from faces
        where faces.asset_id = ${assets.id}
          and faces.ignored = false
          and faces.person_id = ${id}
      )`,
    ),
    sql` and `,
  );
}

function onlyThosePeople(personIds: readonly string[]): SQL {
  const list = sql.join(
    personIds.map((id) => sql`${id}`),
    sql`, `,
  );
  return sql`not exists (
    select 1 from faces
    where faces.asset_id = ${assets.id}
      and faces.ignored = false
      and faces.person_id is not null
      and faces.person_id not in (${list})
  )`;
}

function hasTags(tagIds: readonly string[]): SQL {
  const list = sql.join(
    tagIds.map((id) => sql`${id}`),
    sql`, `,
  );
  return sql`exists (
    select 1 from asset_tags
    where asset_tags.asset_id = ${assets.id}
      and asset_tags.tag_id in (${list})
  )`;
}

function hasTagSlug(slug: string): SQL {
  return sql`exists (
    select 1 from asset_tags
    join tags on tags.id = asset_tags.tag_id
    where asset_tags.asset_id = ${assets.id}
      and tags.slug = ${slug}
  )`;
}

async function covers(
  ctx: Parameters<typeof personSummaries>[0],
  userId: string,
  assetIds: readonly (string | null)[],
): Promise<Map<string, string | null>> {
  const ids = assetIds.filter((id): id is string => id !== null);
  const variants = await availableVariants(ctx.db, ids);
  const urls = new Map<string, string | null>();
  for (const id of ids) {
    const have: Set<MediaVariant> | undefined = variants.get(id);
    urls.set(id, have?.has('thumbnail') ? ctx.media.sign({ assetId: id, variant: 'thumbnail', userId }).url : null);
  }
  return urls;
}

export const searchHandlers: Handlers = {
  'search.query': async ({ ctx, auth, query }) => {
    const userId = auth.user.id;
    const offset = pageOffset(query.cursor);
    const split = query.q ? splitQuery(query.q) : { text: '', year: null };
    const text = split.text;
    const year = split.year;

    let textPersonIds: string[] = [];
    let textTagIds: string[] = [];
    if (text) {
      const named = await ctx.db
        .select({ id: people.id })
        .from(people)
        .where(and(eq(people.ownerId, userId), ilike(people.name, `%${text}%`)));
      textPersonIds = named.map((row) => row.id);
      const slugs = slugsInText(text);
      if (slugs.length > 0) {
        const matched = await ctx.db
          .select({ id: tags.id })
          .from(tags)
          .where(inArray(tags.slug, slugs));
        textTagIds = matched.map((row) => row.id);
      }
    }

    const clipRank =
      text && textPersonIds.length === 0 && textTagIds.length === 0
        ? await similarAssetIds(ctx, userId, text, 200)
        : null;

    const filters: SQL[] = [eq(assets.ownerId, userId), isNull(assets.trashedAt)];
    if (query.tag) {
      const slug = slugsInText(query.tag)[0] ?? query.tag.toLowerCase();
      filters.push(hasTagSlug(slug));
    }
    if (query.personIds && query.personIds.length > 0) {
      filters.push(hasEveryPerson(query.personIds));
      if (query.personMode === 'only') filters.push(onlyThosePeople(query.personIds));
    }
    if (query.minFaces) {
      filters.push(sql`(
        select count(*) from faces
        where faces.asset_id = ${assets.id} and faces.ignored = false
      ) >= ${query.minFaces}`);
    }
    if (query.city) filters.push(ilike(assets.city, query.city));
    if (query.country) filters.push(ilike(assets.country, query.country));
    if (query.type) filters.push(eq(assets.type, query.type));
    if (query.from) filters.push(gte(assets.localDate, query.from));
    if (query.to) filters.push(lte(assets.localDate, query.to));
    if (year) {
      filters.push(gte(assets.localDate, `${year}-01-01`));
      filters.push(lte(assets.localDate, `${year}-12-31`));
    }

    let clipPage: string[] | null = null;
    if (text) {
      const parts: SQL[] = [];
      if (text.length >= 2) parts.push(ilike(assets.originalFilename, `%${text}%`));
      if (textPersonIds.length > 0) parts.push(hasPeople(textPersonIds));
      if (textTagIds.length > 0) parts.push(hasTags(textTagIds));
      if (clipRank) {
        clipPage = clipRank.slice(offset, offset + query.limit + 1);
        if (clipPage.length > 0) parts.push(inArray(assets.id, clipPage.slice(0, query.limit)));
      }
      filters.push(parts.length > 0 ? or(...parts)! : sql`false`);
    }

    const limited = await ctx.db
      .select()
      .from(assets)
      .where(and(...filters))
      .orderBy(sql`${assets.capturedAt} desc nulls last`, desc(assets.id))
      .offset(clipPage ? 0 : offset)
      .limit(query.limit + 1);
    let page = limited.slice(0, query.limit);
    if (clipRank && textPersonIds.length === 0 && textTagIds.length === 0) {
      const rank = new Map(clipRank.map((id, index) => [id, index]));
      page = [...page].sort((left, right) => (rank.get(left.id) ?? 0) - (rank.get(right.id) ?? 0));
    }
    const hasMore = clipPage ? clipPage.length > query.limit : limited.length > query.limit;
    return {
      items: await toSummaries(ctx, userId, page),
      nextCursor: hasMore ? String(offset + query.limit) : null,
      parsed: {
        text: text.length > 0 ? text : null,
        personIds: textPersonIds,
        year,
      },
    };
  },

  'search.suggestions': async ({ ctx, auth, query }) => {
    const q = query.q.trim();
    if (q.length === 0) return { suggestions: [] };
    const userId = auth.user.id;
    const [named, labeled, places] = await Promise.all([
      ctx.db
        .select({ id: people.id, name: people.name })
        .from(people)
        .where(and(eq(people.ownerId, userId), sql`${people.faceCount} > 0`, ilike(people.name, `%${q}%`)))
        .orderBy(desc(people.faceCount))
        .limit(5),
      ctx.db
        .select({ slug: tags.slug, name: tags.name })
        .from(tags)
        .innerJoin(assetTags, eq(assetTags.tagId, tags.id))
        .innerJoin(assets, eq(assets.id, assetTags.assetId))
        .where(
          and(
            eq(assets.ownerId, userId),
            isNull(assets.trashedAt),
            inArray(tags.slug, slugsInText(q).concat(q.toLowerCase())),
          ),
        )
        .groupBy(tags.id, tags.slug, tags.name)
        .limit(5),
      ctx.db
        .select({ city: assets.city })
        .from(assets)
        .where(and(eq(assets.ownerId, userId), isNull(assets.trashedAt), ilike(assets.city, `%${q}%`)))
        .groupBy(assets.city)
        .limit(3),
    ]);
    const suggestions: {
      kind: 'person' | 'place' | 'tag' | 'date' | 'text';
      label: string;
      value: string;
    }[] = [
      ...named.flatMap((person) =>
        person.name
          ? [{ kind: 'person' as const, label: person.name, value: person.id }]
          : [],
      ),
      ...labeled.map((tag) => ({ kind: 'tag' as const, label: tag.name, value: tag.slug })),
      ...places.flatMap((place) =>
        place.city ? [{ kind: 'place' as const, label: place.city, value: place.city }] : [],
      ),
    ];
    const { year } = splitQuery(q);
    if (year && q === String(year)) {
      suggestions.push({ kind: 'date', label: String(year), value: String(year) });
    }
    if (suggestions.length === 0) {
      suggestions.push({ kind: 'text', label: q, value: q });
    }
    return { suggestions: suggestions.slice(0, 8) };
  },

  'explore.get': async ({ ctx, auth }) => {
    const userId = auth.user.id;
    const owned = () => and(eq(assets.ownerId, userId), isNull(assets.trashedAt));
    const [peopleRows, placeRows, thingRows, videoRow, screenshotRow] = await Promise.all([
      ctx.db
        .select()
        .from(people)
        .where(and(eq(people.ownerId, userId), eq(people.isHidden, false), sql`${people.faceCount} > 0`))
        .orderBy(desc(people.faceCount))
        .limit(12),
      ctx.db
        .select({ city: assets.city, count: sql<number>`count(*)::int`, sample: sql<string>`min(${assets.id}::text)` })
        .from(assets)
        .where(and(owned(), isNotNull(assets.city)))
        .groupBy(assets.city)
        .orderBy(desc(sql`count(*)`))
        .limit(12),
      ctx.db
        .select({
          slug: tags.slug,
          name: tags.name,
          count: sql<number>`count(*)::int`,
          sample: sql<string>`min(${assets.id}::text)`,
        })
        .from(assetTags)
        .innerJoin(tags, eq(tags.id, assetTags.tagId))
        .innerJoin(assets, eq(assets.id, assetTags.assetId))
        .where(owned())
        .groupBy(tags.id, tags.slug, tags.name)
        .orderBy(desc(sql`count(*)`))
        .limit(24),
      ctx.db
        .select({ count: sql<number>`count(*)::int`, sample: sql<string | null>`min(${assets.id}::text)` })
        .from(assets)
        .where(and(owned(), eq(assets.type, 'video'))),
      ctx.db
        .select({ count: sql<number>`count(*)::int`, sample: sql<string | null>`min(${assets.id}::text)` })
        .from(assets)
        .where(and(owned(), ilike(assets.originalFilename, '%screenshot%'))),
    ]);

    const coverIds = [
      ...placeRows.map((row) => row.sample),
      ...thingRows.map((row) => row.sample),
      videoRow[0]?.sample ?? null,
      screenshotRow[0]?.sample ?? null,
    ];
    const coverUrls = await covers(ctx, userId, coverIds);
    const cover = (id: string | null | undefined) => (id ? (coverUrls.get(id) ?? null) : null);

    return {
      people: await personSummaries(ctx, userId, peopleRows),
      places: placeRows.flatMap((row) =>
        row.city
          ? [{ label: row.city, value: row.city, count: Number(row.count), coverUrl: cover(row.sample) }]
          : [],
      ),
      things: thingRows.map((row) => ({
        label: row.name,
        value: row.slug,
        count: Number(row.count),
        coverUrl: cover(row.sample),
      })),
      videos: {
        label: 'Videos',
        value: 'video',
        count: Number(videoRow[0]?.count ?? 0),
        coverUrl: cover(videoRow[0]?.sample),
      },
      screenshots: {
        label: 'Screenshots',
        value: 'screenshot',
        count: Number(screenshotRow[0]?.count ?? 0),
        coverUrl: cover(screenshotRow[0]?.sample),
      },
    };
  },
};
