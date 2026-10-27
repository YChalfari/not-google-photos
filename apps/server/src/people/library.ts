import type { PersonSummary } from '@ngp/shared';
import { and, eq, inArray } from 'drizzle-orm';
import type { AppContext } from '../context';
import type { DbOrTx } from '../db/client';
import { faces, people, type PersonRow } from '../db/schema';
import { ApiError } from '../http/errors';
import { availableVariants } from '../media/serve';

/** Recounts faces and repairs a cover that no longer belongs to the person. */
export async function refreshPeople(db: DbOrTx, personIds: readonly string[]): Promise<void> {
  for (const personId of new Set(personIds)) {
    const [person] = await db.select().from(people).where(eq(people.id, personId));
    if (!person) continue;
    const rows = await db
      .select({ id: faces.id, quality: faces.quality })
      .from(faces)
      .where(and(eq(faces.personId, personId), eq(faces.ignored, false)));
    const best = [...rows].sort((left, right) => (right.quality ?? 0) - (left.quality ?? 0))[0];
    const coverStillHere = person.coverFaceId !== null && rows.some((row) => row.id === person.coverFaceId);
    await db
      .update(people)
      .set({
        faceCount: rows.length,
        coverFaceId: coverStillHere ? person.coverFaceId : (best?.id ?? null),
      })
      .where(eq(people.id, personId));
  }
}

export async function requirePerson(
  ctx: AppContext,
  userId: string,
  personId: string,
): Promise<PersonRow> {
  const [person] = await ctx.db
    .select()
    .from(people)
    .where(and(eq(people.id, personId), eq(people.ownerId, userId)));
  if (!person) throw new ApiError('not_found', 'That person is not in your library');
  return person;
}

export async function personSummaries(
  ctx: AppContext,
  userId: string,
  rows: readonly PersonRow[],
): Promise<PersonSummary[]> {
  const coverIds = rows.flatMap((row) => (row.coverFaceId ? [row.coverFaceId] : []));
  const faceRows =
    coverIds.length === 0
      ? []
      : await ctx.db
          .select({ id: faces.id, assetId: faces.assetId })
          .from(faces)
          .where(inArray(faces.id, coverIds));
  const assetByFace = new Map(faceRows.map((row) => [row.id, row.assetId]));
  const variants = await availableVariants(
    ctx.db,
    faceRows.map((row) => row.assetId),
  );
  return rows.map((row) => {
    const assetId = row.coverFaceId ? assetByFace.get(row.coverFaceId) : undefined;
    const coverUrl =
      assetId && variants.get(assetId)?.has('thumbnail')
        ? ctx.media.sign({ assetId, variant: 'thumbnail', userId }).url
        : null;
    return {
      id: row.id,
      name: row.name,
      faceCount: row.faceCount,
      isHidden: row.isHidden,
      hideFromMemories: row.hideFromMemories,
      coverUrl,
    };
  });
}
