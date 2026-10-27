import { AssetUploadFields, type AssetCheckResponse, type AssetVerifyResponse } from '@ngp/shared';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { canViewAsset, filterOwnedAssetIds } from '../authz/access';
import { assets, files } from '../db/schema';
import type { Handlers } from '../http/contract';
import { ApiError, isUniqueViolation, validationError } from '../http/errors';
import { scheduleAssetProcessing } from '../media/derivatives';
import { classifyUpload, originalFilename } from '../media/kinds';
import { receiveUpload } from '../media/multipart';
import { loadAsset, toDetail } from '../media/summaries';
import { partsFromIso } from '../media/time';
import { storageUsageFor } from '../services/accounts';
import { ChecksumMismatchError } from '../storage/provider';

function blankToUndefined(fields: Record<string, string>): Record<string, string> {
  const copy = { ...fields };
  for (const key of ['deviceAssetId', 'versionOf', 'capturedAt', 'modifiedAt', 'filename']) {
    if (copy[key] === '') delete copy[key];
  }
  if (copy.isFavorite === undefined && copy.favorite !== undefined) copy.isFavorite = copy.favorite;
  return copy;
}

export const assetHandlers: Handlers = {
  'assets.check': async ({ ctx, auth, body }): Promise<AssetCheckResponse> => {
    const checksums = [...new Set(body.checksums)];
    const rows = await ctx.db
      .select({ id: assets.id, checksum: assets.checksumSha1 })
      .from(assets)
      .where(and(eq(assets.ownerId, auth.user.id), inArray(assets.checksumSha1, checksums)));
    const byChecksum = new Map(rows.map((row) => [row.checksum, row.id]));
    const missing: string[] = [];
    const present: AssetCheckResponse['present'] = [];
    for (const checksum of checksums) {
      const assetId = byChecksum.get(checksum);
      if (assetId) present.push({ checksum, assetId });
      else missing.push(checksum);
    }
    return { missing, present };
  },

  'assets.upload': async ({ c, ctx, auth, setStatus }) => {
    const received = await receiveUpload(c.req.raw, async (stream) => {
      const { file } = await ctx.files.ingest(stream);
      return file;
    });
    const file = received.result;
    const raw = blankToUndefined(received.fields);
    if (!raw.filename) raw.filename = received.filename;
    const parsed = AssetUploadFields.safeParse(raw);
    if (!parsed.success) throw validationError(parsed.error, 'body');
    const fields = parsed.data;

    if (file.sha1 !== fields.checksum) {
      throw new ChecksumMismatchError('sha1', fields.checksum, file.sha1);
    }
    if (file.sizeBytes === 0) {
      throw new ApiError('bad_request', 'The file is empty');
    }
    const kind = classifyUpload(fields.filename, received.mimeType, raw.mimeType);
    if (!kind) {
      throw new ApiError(
        'unsupported_media_type',
        'That file is not a photo or video this library can store',
      );
    }

    const filename = originalFilename(fields.filename);
    const [existing] = await ctx.db
      .select({ id: assets.id })
      .from(assets)
      .where(and(eq(assets.ownerId, auth.user.id), eq(assets.checksumSha1, fields.checksum)));
    if (existing) {
      setStatus(200);
      return { assetId: existing.id, status: 'duplicate' as const };
    }

    if (auth.user.quotaBytes != null) {
      const usage = await storageUsageFor(ctx.db, auth.user);
      if (usage.usedBytes + file.sizeBytes > auth.user.quotaBytes) {
        throw new ApiError('quota_exceeded', 'This upload would pass your storage quota');
      }
    }

    if (fields.versionOf) {
      const [original] = await ctx.db
        .select({ id: assets.id })
        .from(assets)
        .where(and(eq(assets.id, fields.versionOf), eq(assets.ownerId, auth.user.id)));
      if (!original) {
        throw new ApiError('bad_request', "That original isn't in your library");
      }
    }

    const when = partsFromIso(fields.capturedAt ?? fields.modifiedAt ?? new Date().toISOString());
    try {
      const [created] = await ctx.db
        .insert(assets)
        .values({
          ownerId: auth.user.id,
          fileId: file.id,
          type: kind.type,
          checksumSha1: fields.checksum,
          originalFilename: filename,
          mimeType: kind.mime,
          deviceId: auth.device?.id ?? null,
          deviceAssetId: fields.deviceAssetId || null,
          capturedAt: when?.capturedAt ?? null,
          capturedLocal: when ? sql`${when.wallClock}::timestamp` : null,
          timezone: when?.timezone ?? null,
          localDate: when?.localDate ?? null,
          fileModifiedAt: fields.modifiedAt ? new Date(fields.modifiedAt) : null,
          durationMs: fields.durationMs ?? null,
          isFavorite: fields.isFavorite ?? false,
          versionOfId: fields.versionOf ?? null,
          processingState: 'pending',
        })
        .returning({ id: assets.id });
      if (!created) throw new Error('Insert returned no asset');
      if (!file.mimeType) {
        await ctx.db.update(files).set({ mimeType: kind.mime }).where(eq(files.id, file.id));
      }
      await scheduleAssetProcessing(ctx, created.id);
      ctx.log.info(
        { assetId: created.id, userId: auth.user.id, bytes: file.sizeBytes },
        'Stored upload',
      );
      return { assetId: created.id, status: 'created' as const };
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const [race] = await ctx.db
        .select({ id: assets.id })
        .from(assets)
        .where(and(eq(assets.ownerId, auth.user.id), eq(assets.checksumSha1, fields.checksum)));
      if (!race) throw error;
      setStatus(200);
      return { assetId: race.id, status: 'duplicate' as const };
    }
  },

  'assets.verify': async ({ ctx, auth, body }): Promise<AssetVerifyResponse> => {
    const status = await ctx.library.status();
    if (status.state !== 'ok') {
      throw new ApiError('library_unavailable', status.message, { details: { library: status } });
    }
    const checksums = body.items.map((item) => item.checksum);
    const rows = await ctx.db
      .select({ assetId: assets.id, checksum: assets.checksumSha1, file: files })
      .from(assets)
      .innerJoin(files, eq(files.id, assets.fileId))
      .where(and(eq(assets.ownerId, auth.user.id), inArray(assets.checksumSha1, checksums)));
    const byChecksum = new Map(rows.map((row) => [row.checksum, row]));
    const results: AssetVerifyResponse['results'] = [];
    for (const item of body.items) {
      const row = byChecksum.get(item.checksum);
      if (!row) {
        results.push({ checksum: item.checksum, assetId: null, status: 'missing' });
        continue;
      }
      if (row.file.sizeBytes !== item.size) {
        results.push({ checksum: item.checksum, assetId: row.assetId, status: 'mismatch' });
        continue;
      }
      const verdict = await ctx.files.verify(row.file);
      results.push({ checksum: item.checksum, assetId: row.assetId, status: verdict });
    }
    return { results };
  },

  'assets.get': async ({ ctx, auth, params }) => {
    const asset = await loadAsset(ctx.db, params.id);
    if (!asset || !(await canViewAsset(ctx.db, auth.user.id, asset.id))) {
      throw new ApiError('not_found', 'That photo is not in your library');
    }
    return toDetail(ctx, auth.user.id, asset);
  },

  'assets.update': async ({ ctx, auth, body }) => {
    const owned = await filterOwnedAssetIds(ctx.db, auth.user.id, body.ids);
    if (owned.size === 0) return { updated: 0 };
    const updated = await ctx.db
      .update(assets)
      .set({
        ...(body.isFavorite !== undefined ? { isFavorite: body.isFavorite } : {}),
        ...(body.isArchived !== undefined ? { isArchived: body.isArchived } : {}),
        ...(body.isTrashed === true
          ? { trashedAt: sql`coalesce(${assets.trashedAt}, now())` }
          : {}),
        ...(body.isTrashed === false ? { trashedAt: null } : {}),
      })
      .where(and(eq(assets.ownerId, auth.user.id), inArray(assets.id, [...owned])))
      .returning({ id: assets.id });
    return { updated: updated.length };
  },
};
