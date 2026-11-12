/**
 * Who can see what. Every query that returns library data must go through one of these, so one
 * account never sees another's photos, faces, or people unless they were shared.
 *
 * Sharing happens only through albums:
 * - Album owners and members who accepted the invitation can see the album and its assets.
 *   Pending invitations grant nothing.
 * - Assets are visible to their owner (including in the trash), and to anyone who can see an
 *   album that contains them, unless the owner trashed them.
 * - People and faces are private to the library they belong to. The exception is a person linked
 *   to a live album (`album_rules`): album members can see that person, and that person's faces
 *   on the album's assets, but none of the owner's other people or faces.
 *
 * The SQL conditions reference the outer table by its real name (`assets`, `albums`, `people`,
 * `faces`); pass an alias as the second argument when the outer query aliases it.
 */
import { and, eq, inArray, sql, type SQL } from 'drizzle-orm';
import type { DbOrTx } from '../db/client';
import { albumMembers, albums, assets, faces, people } from '../db/schema';

/** Ids of albums the person owns or has joined. */
export function accessibleAlbumIds(userId: string): SQL {
  return sql`(
    select authz_al.id from albums authz_al where authz_al.owner_id = ${userId}
    union all
    select authz_am.album_id from album_members authz_am
    where authz_am.user_id = ${userId} and authz_am.accepted_at is not null
  )`;
}

export function albumVisibleTo(userId: string, album: typeof albums = albums): SQL {
  return sql`${album.id} in ${accessibleAlbumIds(userId)}`;
}

export function assetVisibleTo(userId: string, asset: typeof assets = assets): SQL {
  return sql`(
    ${asset.ownerId} = ${userId}
    or (${asset.trashedAt} is null and ${asset.intake} = 'library' and exists (
      select 1 from album_assets authz_aa
      where authz_aa.asset_id = ${asset.id} and authz_aa.album_id in ${accessibleAlbumIds(userId)}
    ))
  )`;
}

/**
 * What belongs in someone's timeline, search, and memories: their own assets, plus assets of
 * albums they joined and switched "show in my timeline" on for. Callers still filter trash and
 * archive for the owner's own assets.
 */
export function assetInTimelineOf(userId: string, asset: typeof assets = assets): SQL {
  return sql`(
    (${asset.ownerId} = ${userId} and ${asset.intake} = 'library')
    or (${asset.trashedAt} is null and ${asset.intake} = 'library' and exists (
      select 1 from album_assets authz_aa
      join album_members authz_am on authz_am.album_id = authz_aa.album_id
      where authz_aa.asset_id = ${asset.id}
        and authz_am.user_id = ${userId}
        and authz_am.accepted_at is not null
        and authz_am.show_in_timeline
    ))
  )`;
}

export function personVisibleTo(userId: string, person: typeof people = people): SQL {
  return sql`(
    ${person.ownerId} = ${userId}
    or exists (
      select 1 from album_rules authz_ar
      where authz_ar.person_id = ${person.id} and authz_ar.album_id in ${accessibleAlbumIds(userId)}
    )
  )`;
}

export function faceVisibleTo(userId: string, face: typeof faces = faces): SQL {
  return sql`(
    ${face.ownerId} = ${userId}
    or exists (
      select 1 from album_rules authz_ar
      join album_assets authz_aa on authz_aa.album_id = authz_ar.album_id
      join assets authz_asset on authz_asset.id = authz_aa.asset_id
      where authz_ar.person_id = ${face.personId}
        and authz_aa.asset_id = ${face.assetId}
        and authz_asset.trashed_at is null
        and authz_asset.intake = 'library'
        and authz_ar.album_id in ${accessibleAlbumIds(userId)}
    )
  )`;
}

export async function canViewAsset(db: DbOrTx, userId: string, assetId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: assets.id })
    .from(assets)
    .where(and(eq(assets.id, assetId), assetVisibleTo(userId)));
  return row !== undefined;
}

/** The subset of `assetIds` the person can see. */
export async function filterVisibleAssetIds(
  db: DbOrTx,
  userId: string,
  assetIds: readonly string[],
): Promise<Set<string>> {
  if (assetIds.length === 0) return new Set();
  const rows = await db
    .select({ id: assets.id })
    .from(assets)
    .where(and(inArray(assets.id, [...new Set(assetIds)]), assetVisibleTo(userId)));
  return new Set(rows.map((row) => row.id));
}

/** The subset of `assetIds` the person owns (only owners can edit, trash, or delete). */
export async function filterOwnedAssetIds(
  db: DbOrTx,
  userId: string,
  assetIds: readonly string[],
): Promise<Set<string>> {
  if (assetIds.length === 0) return new Set();
  const rows = await db
    .select({ id: assets.id })
    .from(assets)
    .where(and(inArray(assets.id, [...new Set(assetIds)]), eq(assets.ownerId, userId)));
  return new Set(rows.map((row) => row.id));
}

export async function canViewAlbum(db: DbOrTx, userId: string, albumId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: albums.id })
    .from(albums)
    .where(and(eq(albums.id, albumId), albumVisibleTo(userId)));
  return row !== undefined;
}

/** Owners and accepted contributors can add photos to an album. */
export async function canContributeToAlbum(db: DbOrTx, userId: string, albumId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: albums.id })
    .from(albums)
    .leftJoin(
      albumMembers,
      and(eq(albumMembers.albumId, albums.id), eq(albumMembers.userId, userId)),
    )
    .where(
      and(
        eq(albums.id, albumId),
        sql`(${albums.ownerId} = ${userId} or (${albumMembers.role} = 'contributor' and ${albumMembers.acceptedAt} is not null))`,
      ),
    );
  return row !== undefined;
}

export async function canViewPerson(db: DbOrTx, userId: string, personId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: people.id })
    .from(people)
    .where(and(eq(people.id, personId), personVisibleTo(userId)));
  return row !== undefined;
}

/** Faces on one asset the person can see (with an assigned person only when that person is visible). */
export async function visibleFacesOnAsset(db: DbOrTx, userId: string, assetId: string) {
  return db
    .select({
      id: faces.id,
      ownerId: faces.ownerId,
      personId: faces.personId,
      boxX: faces.boxX,
      boxY: faces.boxY,
      boxWidth: faces.boxWidth,
      boxHeight: faces.boxHeight,
    })
    .from(faces)
    .where(and(eq(faces.assetId, assetId), eq(faces.ignored, false), faceVisibleTo(userId)));
}
