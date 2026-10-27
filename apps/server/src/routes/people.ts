import type { FaceSummary } from '@ngp/shared';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { albumRules, assets, faceFeedback, faces, people, type FaceRow, type PersonRow } from '../db/schema';
import { ApiError } from '../http/errors';
import type { Handlers } from '../http/contract';
import { toSummaries } from '../media/summaries';
import { personSummaries, refreshPeople, requirePerson } from '../people/library';

function pageOffset(cursor: string | undefined): number {
  if (!cursor) return 0;
  const value = Number(cursor);
  return Number.isInteger(value) && value >= 0 ? value : 0;
}

function toFace(row: FaceRow): FaceSummary {
  return {
    id: row.id,
    assetId: row.assetId,
    box: { x: row.boxX, y: row.boxY, width: row.boxWidth, height: row.boxHeight },
    personId: row.personId,
    ignored: row.ignored,
  };
}

export const peopleHandlers: Handlers = {
  'people.list': async ({ ctx, auth, query }) => {
    const rows = await ctx.db
      .select()
      .from(people)
      .where(
        and(
          eq(people.ownerId, auth.user.id),
          sql`${people.faceCount} > 0`,
          query.includeHidden ? sql`true` : eq(people.isHidden, false),
        ),
      )
      .orderBy(desc(people.faceCount), people.name);
    return { people: await personSummaries(ctx, auth.user.id, rows) };
  },

  'people.get': async ({ ctx, auth, params }) => {
    const person = await requirePerson(ctx, auth.user.id, params.id);
    const [summary] = await personSummaries(ctx, auth.user.id, [person]);
    return { person: summary! };
  },

  'people.update': async ({ ctx, auth, params, body }) => {
    const person = await requirePerson(ctx, auth.user.id, params.id);
    let nextCover: string | undefined;
    if (body.coverFaceId) {
      const [face] = await ctx.db
        .select({ id: faces.id })
        .from(faces)
        .where(and(eq(faces.id, body.coverFaceId), eq(faces.personId, person.id)));
      if (!face) throw new ApiError('not_found', 'That face is not one of theirs');
      nextCover = face.id;
    } else if (body.coverAssetId) {
      const [face] = await ctx.db
        .select({ id: faces.id })
        .from(faces)
        .where(
          and(
            eq(faces.assetId, body.coverAssetId),
            eq(faces.personId, person.id),
            eq(faces.ownerId, auth.user.id),
            eq(faces.ignored, false),
          ),
        )
        .orderBy(sql`${faces.quality} desc nulls last`)
        .limit(1);
      if (!face) throw new ApiError('not_found', 'That photo does not show this person');
      nextCover = face.id;
    }
    const [updated] = await ctx.db
      .update(people)
      .set({
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.isHidden !== undefined ? { isHidden: body.isHidden } : {}),
        ...(body.hideFromMemories !== undefined ? { hideFromMemories: body.hideFromMemories } : {}),
        ...(nextCover !== undefined ? { coverFaceId: nextCover } : {}),
      })
      .where(eq(people.id, person.id))
      .returning();
    const [summary] = await personSummaries(ctx, auth.user.id, [updated!]);
    return { person: summary! };
  },

  'people.merge': async ({ ctx, auth, params, body }) => {
    const target = await requirePerson(ctx, auth.user.id, params.id);
    const sourceIds = [...new Set(body.sourcePersonIds)].filter((id) => id !== target.id);
    if (sourceIds.length === 0) {
      throw new ApiError('bad_request', 'Choose a different person to merge');
    }
    const sources: PersonRow[] = [];
    for (const sourceId of sourceIds) sources.push(await requirePerson(ctx, auth.user.id, sourceId));

    const keptCover = target.coverFaceId;
    let name = target.name;
    let coverFaceId = target.coverFaceId;
    await ctx.db.transaction(async (tx) => {
      for (const source of sources) {
        const rules = await tx.select().from(albumRules).where(eq(albumRules.personId, source.id));
        for (const rule of rules) {
          const [clash] = await tx
            .select({ id: albumRules.id })
            .from(albumRules)
            .where(and(eq(albumRules.albumId, rule.albumId), eq(albumRules.personId, target.id)));
          if (clash) await tx.delete(albumRules).where(eq(albumRules.id, rule.id));
          else await tx.update(albumRules).set({ personId: target.id }).where(eq(albumRules.id, rule.id));
        }
        await tx
          .update(faces)
          .set({ personId: target.id, assignedManually: true })
          .where(and(eq(faces.personId, source.id), eq(faces.ownerId, auth.user.id)));
        if (!name && source.name) name = source.name;
        if (!coverFaceId && source.coverFaceId) coverFaceId = source.coverFaceId;
        await tx.delete(people).where(eq(people.id, source.id));
      }
      await tx.update(people).set({ name, coverFaceId }).where(eq(people.id, target.id));
      await refreshPeople(tx, [target.id]);
      if (keptCover) {
        await tx.update(people).set({ coverFaceId: keptCover }).where(eq(people.id, target.id));
      }
    });

    const person = await requirePerson(ctx, auth.user.id, target.id);
    const [summary] = await personSummaries(ctx, auth.user.id, [person]);
    return { person: summary! };
  },

  'people.assets': async ({ ctx, auth, params, query }) => {
    await requirePerson(ctx, auth.user.id, params.id);
    const offset = pageOffset(query.cursor);
    const rows = await ctx.db
      .select()
      .from(assets)
      .where(
        and(
          eq(assets.ownerId, auth.user.id),
          isNull(assets.trashedAt),
          sql`exists (
            select 1 from faces
            where faces.asset_id = ${assets.id}
              and faces.person_id = ${params.id}
              and faces.ignored = false
          )`,
        ),
      )
      .orderBy(sql`${assets.capturedAt} desc nulls last`, desc(assets.id))
      .offset(offset)
      .limit(query.limit + 1);
    const page = rows.slice(0, query.limit);
    return {
      items: await toSummaries(ctx, auth.user.id, page),
      nextCursor: rows.length > query.limit ? String(offset + query.limit) : null,
    };
  },

  'faces.update': async ({ ctx, auth, params, body }) => {
    const [face] = await ctx.db
      .select()
      .from(faces)
      .where(and(eq(faces.id, params.id), eq(faces.ownerId, auth.user.id)));
    if (!face) throw new ApiError('not_found', 'That face is not in your library');
    let nextPersonId: string | null | undefined;
    if (body.createPerson) {
      const [created] = await ctx.db
        .insert(people)
        .values({ ownerId: auth.user.id })
        .returning({ id: people.id });
      if (!created) throw new ApiError('internal_error', 'Could not add that person');
      nextPersonId = created.id;
    } else if (body.personId !== undefined) {
      if (body.personId) await requirePerson(ctx, auth.user.id, body.personId);
      nextPersonId = body.personId;
    }
    const [updated] = await ctx.db
      .update(faces)
      .set({
        ...(nextPersonId !== undefined ? { personId: nextPersonId } : {}),
        ...(body.ignored !== undefined ? { ignored: body.ignored } : {}),
        assignedManually: true,
      })
      .where(eq(faces.id, face.id))
      .returning();
    await refreshPeople(
      ctx.db,
      [face.personId, updated?.personId].flatMap((id) => (id ? [id] : [])),
    );
    return { face: toFace(updated!) };
  },

  'faces.notThisPerson': async ({ ctx, auth, params, body }) => {
    const [face] = await ctx.db
      .select()
      .from(faces)
      .where(and(eq(faces.id, params.id), eq(faces.ownerId, auth.user.id)));
    if (!face) throw new ApiError('not_found', 'That face is not in your library');
    const person = await requirePerson(ctx, auth.user.id, body.personId);
    await ctx.db
      .insert(faceFeedback)
      .values({ faceId: face.id, personId: person.id, ownerId: auth.user.id, kind: 'not_this_person' })
      .onConflictDoNothing();
    await ctx.db
      .update(faces)
      .set({
        assignedManually: true,
        ...(face.personId === person.id ? { personId: null } : {}),
      })
      .where(eq(faces.id, face.id));
    if (face.personId) await refreshPeople(ctx.db, [face.personId]);
  },
};
