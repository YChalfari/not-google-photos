import type { PersonSummary } from '@ngp/shared';
import { and, eq, sql } from 'drizzle-orm';
import type { DbOrTx } from '../db/client';
import { albumAssets, albumRules, people, users } from '../db/schema';
import { cosineDistance, parseVector } from '../recognition/scoring';

/** Closer than automatic matching, so a suggestion is a person you would actually confirm. */
const SUGGEST_MAX_DISTANCE = 0.45;

/**
 * A face satisfies a rule. Together-rules also need another person this member linked to the
 * same album in the photo. That other person's own start date does not matter.
 */
function faceMatchesRule(rule: string, face: string, asset: string) {
  return sql`
    ${sql.raw(face)}.person_id = ${sql.raw(rule)}.person_id
    and ${sql.raw(face)}.owner_id = ${sql.raw(rule)}.user_id
    and ${sql.raw(face)}.ignored = false
    and ${sql.raw(asset)}.id = ${sql.raw(face)}.asset_id
    and ${sql.raw(asset)}.trashed_at is null
    and ${sql.raw(asset)}.intake = 'library'
    and ${sql.raw(asset)}.owner_id = ${sql.raw(rule)}.user_id
    and (
      ${sql.raw(rule)}.start_date is null
      or (
        ${sql.raw(asset)}.local_date is not null
        and ${sql.raw(asset)}.local_date >= ${sql.raw(rule)}.start_date
      )
    )
    and (
      not ${sql.raw(rule)}.together
      or exists (
        select 1
        from faces together_face
        inner join album_rules together_rule
          on together_rule.person_id = together_face.person_id
         and together_rule.album_id = ${sql.raw(rule)}.album_id
         and together_rule.user_id = ${sql.raw(rule)}.user_id
         and together_rule.person_id <> ${sql.raw(rule)}.person_id
        where together_face.asset_id = ${sql.raw(asset)}.id
          and together_face.owner_id = ${sql.raw(rule)}.user_id
          and together_face.ignored = false
      )
    )
  `;
}

/** Adds this person's current non-trashed photos. Later photos are picked up by sync. */
export async function applyAlbumRule(db: DbOrTx, ruleId: string): Promise<void> {
  const [rule] = await db.select().from(albumRules).where(eq(albumRules.id, ruleId));
  if (!rule) return;
  await resyncUserAlbumRules(db, rule.albumId, rule.userId);
}

/**
 * Rebuilds one member's rule photos for an album.
 * Adding or removing someone changes which together-photos qualify, including photos that were
 * stored under a different person's rule.
 */
export async function resyncUserAlbumRules(
  db: DbOrTx,
  albumId: string,
  userId: string,
): Promise<void> {
  await db.execute(sql`
    delete from album_assets aa
    where aa.album_id = ${albumId}
      and aa.source = 'rule'
      and aa.added_by_id = ${userId}
      and not exists (
        select 1
        from album_rules r
        join faces f on f.asset_id = aa.asset_id
        join assets a on a.id = aa.asset_id
        where r.album_id = aa.album_id
          and r.user_id = ${userId}
          and ${faceMatchesRule('r', 'f', 'a')}
      )
  `);
  await db.execute(sql`
    insert into album_assets (album_id, asset_id, added_by_id, source, rule_id)
    select r.album_id, a.id, r.user_id, 'rule', r.id
    from album_rules r
    join faces f on f.person_id = r.person_id and f.owner_id = r.user_id
    join assets a on a.id = f.asset_id
    where r.album_id = ${albumId}
      and r.user_id = ${userId}
      and ${faceMatchesRule('r', 'f', 'a')}
    on conflict (album_id, asset_id) do nothing
  `);
}

export async function removeAlbumRuleLinks(db: DbOrTx, ruleId: string): Promise<void> {
  await db
    .delete(albumAssets)
    .where(and(eq(albumAssets.ruleId, ruleId), eq(albumAssets.source, 'rule')));
}

/** Keeps rule membership for these photos in step with who is in them. */
export async function syncAlbumRulesForAssets(
  db: DbOrTx,
  assetIds: readonly string[],
): Promise<void> {
  if (assetIds.length === 0) return;
  const ids = sql.join(
    assetIds.map((id) => sql`${id}`),
    sql`, `,
  );
  await db.execute(sql`
    delete from album_assets aa
    where aa.asset_id in (${ids})
      and aa.source = 'rule'
      and aa.rule_id is not null
      and not exists (
        select 1
        from album_rules r
        join faces f on f.asset_id = aa.asset_id
        join assets a on a.id = aa.asset_id
        where r.id = aa.rule_id
          and ${faceMatchesRule('r', 'f', 'a')}
      )
  `);
  await db.execute(sql`
    insert into album_assets (album_id, asset_id, added_by_id, source, rule_id)
    select r.album_id, a.id, r.user_id, 'rule', r.id
    from faces f
    join album_rules r on r.person_id = f.person_id and r.user_id = f.owner_id
    join assets a on a.id = f.asset_id
    where f.asset_id in (${ids})
      and ${faceMatchesRule('r', 'f', 'a')}
    on conflict (album_id, asset_id) do nothing
  `);
}

export async function syncAlbumRulesForAsset(db: DbOrTx, assetId: string): Promise<void> {
  await syncAlbumRulesForAssets(db, [assetId]);
}

export interface RuleSuggestion {
  ruleId: string;
  sharedBy: { id: string; name: string };
  sharedPersonName: string | null;
  candidate: PersonSummary;
  similarity: number;
}

/**
 * People in your library who look like someone another member already linked.
 * Confirming is a separate step that creates your own rule. Nothing is merged across libraries.
 */
export async function suggestRulesForAlbum(
  db: DbOrTx,
  userId: string,
  albumId: string,
): Promise<RuleSuggestion[]> {
  const shared = await db
    .select({
      ruleId: albumRules.id,
      userId: albumRules.userId,
      personId: albumRules.personId,
      personName: people.name,
      sharedByName: users.name,
    })
    .from(albumRules)
    .innerJoin(people, eq(people.id, albumRules.personId))
    .innerJoin(users, eq(users.id, albumRules.userId))
    .where(and(eq(albumRules.albumId, albumId), sql`${albumRules.userId} <> ${userId}`));
  if (shared.length === 0) return [];

  const mine = await db
    .select({
      id: people.id,
      name: people.name,
      faceCount: people.faceCount,
      isHidden: people.isHidden,
      hideFromMemories: people.hideFromMemories,
    })
    .from(people)
    .where(eq(people.ownerId, userId));
  if (mine.length === 0) return [];

  const already = new Set(
    (
      await db
        .select({ personId: albumRules.personId })
        .from(albumRules)
        .where(and(eq(albumRules.albumId, albumId), eq(albumRules.userId, userId)))
    ).map((row) => row.personId),
  );
  const candidates = mine.filter((person) => !already.has(person.id));
  if (candidates.length === 0) return [];

  const embeddings = await representativeEmbeddings(db, [
    ...shared.map((row) => row.personId),
    ...candidates.map((person) => person.id),
  ]);

  const suggestions: RuleSuggestion[] = [];
  const used = new Set<string>();
  for (const rule of shared) {
    const sharedEmbedding = embeddings.get(rule.personId);
    if (!sharedEmbedding) continue;
    let best: { person: (typeof candidates)[number]; distance: number } | undefined;
    for (const person of candidates) {
      const embedding = embeddings.get(person.id);
      if (!embedding || embedding.length !== sharedEmbedding.length) continue;
      const distance = cosineDistance(sharedEmbedding, embedding);
      if (!best || distance < best.distance) best = { person, distance };
    }
    if (!best || best.distance > SUGGEST_MAX_DISTANCE || used.has(best.person.id)) continue;
    used.add(best.person.id);
    suggestions.push({
      ruleId: rule.ruleId,
      sharedBy: { id: rule.userId, name: rule.sharedByName },
      sharedPersonName: rule.personName,
      candidate: {
        id: best.person.id,
        name: best.person.name,
        faceCount: best.person.faceCount,
        isHidden: best.person.isHidden,
        hideFromMemories: best.person.hideFromMemories,
        coverUrl: null,
        coverAssetId: null,
        coverBox: null,
      },
      similarity: Math.min(1, Math.max(0, 1 - best.distance)),
    });
  }
  return suggestions;
}

function isRowResult(result: unknown): result is { rows: unknown } {
  return result !== null && typeof result === 'object' && 'rows' in result;
}

function queryRows(result: unknown): Array<Record<string, unknown>> {
  const rows = Array.isArray(result) ? result : isRowResult(result) ? result.rows : [];
  if (!Array.isArray(rows)) return [];
  return rows.filter(
    (row): row is Record<string, unknown> => row !== null && typeof row === 'object',
  );
}

async function representativeEmbeddings(
  db: DbOrTx,
  personIds: readonly string[],
): Promise<Map<string, number[]>> {
  const unique = [...new Set(personIds)];
  const found = new Map<string, number[]>();
  if (unique.length === 0) return found;
  const result = await db.execute(sql`
    select distinct on (person_id) person_id, embedding::text as embedding
    from faces
    where person_id in (${sql.join(
      unique.map((id) => sql`${id}`),
      sql`, `,
    )})
      and embedding is not null
      and ignored = false
    order by person_id, quality desc nulls last
  `);
  for (const row of queryRows(result)) {
    if (typeof row.person_id !== 'string') continue;
    const embedding = parseVector(row.embedding);
    if (embedding) found.set(row.person_id, embedding);
  }
  return found;
}
