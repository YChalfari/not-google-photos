import type { AssetDetail, AssetSummary, MediaVariant } from '@ngp/shared';
import { and, eq, inArray } from 'drizzle-orm';
import type { AppContext } from '../context';
import type { DbOrTx } from '../db/client';
import { assetTags, assets, files, people, tags, users, type AssetRow } from '../db/schema';
import { visibleFacesOnAsset } from '../authz/access';
import { availableVariants } from './serve';

function signed(
  ctx: AppContext,
  userId: string,
  assetId: string,
  variant: MediaVariant,
  variants: Set<MediaVariant> | undefined,
): string | null {
  if (variant !== 'original' && !variants?.has(variant)) return null;
  if (variant === 'original' && !variants?.has('original')) return null;
  return ctx.media.sign({ assetId, variant, userId }).url;
}

export async function toSummaries(
  ctx: AppContext,
  userId: string,
  rows: readonly AssetRow[],
): Promise<AssetSummary[]> {
  const variants = await availableVariants(
    ctx.db,
    rows.map((row) => row.id),
  );
  return rows.map((row) => {
    const have = variants.get(row.id);
    return {
      id: row.id,
      type: row.type,
      ownerId: row.ownerId,
      capturedAt: row.capturedAt?.toISOString() ?? null,
      localDate: row.localDate,
      width: row.width,
      height: row.height,
      durationMs: row.durationMs,
      isFavorite: row.isFavorite,
      thumbhash: row.thumbhash,
      thumbnailUrl: signed(ctx, userId, row.id, 'thumbnail', have),
      previewUrl: signed(ctx, userId, row.id, 'preview', have),
    };
  });
}

export async function toDetail(
  ctx: AppContext,
  userId: string,
  asset: AssetRow,
): Promise<AssetDetail> {
  const [summary] = await toSummaries(ctx, userId, [asset]);
  if (!summary) throw new Error(`Asset ${asset.id} disappeared while it was being read`);

  const [owner] = await ctx.db
    .select({ id: users.id, name: users.name })
    .from(users)
    .where(eq(users.id, asset.ownerId));
  const [file] = await ctx.db
    .select({ sizeBytes: files.sizeBytes })
    .from(files)
    .where(eq(files.id, asset.fileId));
  const variants = await availableVariants(ctx.db, [asset.id]);
  const have = variants.get(asset.id);

  const faceRows = await visibleFacesOnAsset(ctx.db, userId, asset.id);
  const personIds = [
    ...new Set(faceRows.flatMap((face) => (face.personId ? [face.personId] : []))),
  ];
  const personRows =
    personIds.length === 0
      ? []
      : await ctx.db
          .select({ id: people.id, name: people.name })
          .from(people)
          .where(inArray(people.id, personIds));
  const personById = new Map(personRows.map((person) => [person.id, person]));

  const tagRows = await ctx.db
    .select({ name: tags.name, confidence: assetTags.confidence })
    .from(assetTags)
    .innerJoin(tags, eq(tags.id, assetTags.tagId))
    .where(eq(assetTags.assetId, asset.id));

  const location =
    asset.latitude != null && asset.longitude != null
      ? {
          latitude: asset.latitude,
          longitude: asset.longitude,
          city: asset.city,
          country: asset.country,
        }
      : null;
  const camera =
    asset.cameraMake || asset.cameraModel || asset.lensModel
      ? { make: asset.cameraMake, model: asset.cameraModel, lens: asset.lensModel }
      : null;

  return {
    ...summary,
    originalFilename: asset.originalFilename,
    mimeType: asset.mimeType,
    sizeBytes: file?.sizeBytes ?? 0,
    timezone: asset.timezone,
    isArchived: asset.isArchived,
    trashedAt: asset.trashedAt?.toISOString() ?? null,
    owner: { id: owner?.id ?? asset.ownerId, name: owner?.name ?? '' },
    location,
    camera,
    faces: faceRows.map((face) => {
      const person = face.personId ? personById.get(face.personId) : undefined;
      return {
        id: face.id,
        box: { x: face.boxX, y: face.boxY, width: face.boxWidth, height: face.boxHeight },
        person: person ? { id: person.id, name: person.name } : null,
      };
    }),
    tags: tagRows.map((tag) => ({
      name: tag.name,
      confidence: Math.min(1, Math.max(0, tag.confidence)),
    })),
    originalUrl: signed(ctx, userId, asset.id, 'original', have),
    playbackUrl: signed(ctx, userId, asset.id, 'playback', have),
  };
}

export async function loadAsset(db: DbOrTx, assetId: string): Promise<AssetRow | undefined> {
  const [row] = await db
    .select()
    .from(assets)
    .where(and(eq(assets.id, assetId)));
  return row;
}
