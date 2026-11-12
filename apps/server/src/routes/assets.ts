import { AssetUploadFields, type AssetCheckResponse, type AssetVerifyResponse } from '@ngp/shared';
import type { CleanupFilter } from '@ngp/shared';
import { and, desc, eq, ilike, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import { canViewAsset, filterOwnedAssetIds } from '../authz/access';
import { assets, files, rejectedChecksums } from '../db/schema';
import type { Handlers } from '../http/contract';
import { ApiError, isUniqueViolation, validationError } from '../http/errors';
import { syncAlbumRulesForAssets } from '../albums/rules';
import { deleteTrashedAssets } from '../jobs/maintenance';
import { scheduleAssetProcessing } from '../media/derivatives';
import { classifyUpload, originalFilename } from '../media/kinds';
import { receiveUpload } from '../media/multipart';
import { loadAsset, toDetail, toSummaries } from '../media/summaries';
import { partsFromIso } from '../media/time';
import { scheduleRecognition } from '../recognition/recognize';
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
      .select({ id: assets.id, checksum: assets.checksumSha1, intake: assets.intake })
      .from(assets)
      .where(and(eq(assets.ownerId, auth.user.id), inArray(assets.checksumSha1, checksums)));
    const byChecksum = new Map(rows.map((row) => [row.checksum, row]));
    const refused = await ctx.db
      .select({ sha1: rejectedChecksums.sha1 })
      .from(rejectedChecksums)
      .where(
        and(
          eq(rejectedChecksums.ownerId, auth.user.id),
          inArray(rejectedChecksums.sha1, checksums),
        ),
      );
    const rejectedSet = new Set(refused.map((row) => row.sha1));
    const missing: string[] = [];
    const present: AssetCheckResponse['present'] = [];
    const held: AssetCheckResponse['held'] = [];
    const rejected: string[] = [];
    for (const checksum of checksums) {
      const row = byChecksum.get(checksum);
      if (row?.intake === 'library') present.push({ checksum, assetId: row.id });
      else if (row?.intake === 'review') held.push({ checksum, assetId: row.id });
      else if (rejectedSet.has(checksum)) rejected.push(checksum);
      else missing.push(checksum);
    }
    return { missing, present, held, rejected };
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
      .select({ id: assets.id, intake: assets.intake })
      .from(assets)
      .where(and(eq(assets.ownerId, auth.user.id), eq(assets.checksumSha1, fields.checksum)));
    if (existing) {
      setStatus(200);
      return { assetId: existing.id, status: 'duplicate' as const, intake: existing.intake };
    }
    const [refused] = await ctx.db
      .select({ sha1: rejectedChecksums.sha1 })
      .from(rejectedChecksums)
      .where(
        and(
          eq(rejectedChecksums.ownerId, auth.user.id),
          eq(rejectedChecksums.sha1, fields.checksum),
        ),
      );
    if (refused) {
      setStatus(200);
      return { assetId: null, status: 'rejected' as const, intake: null };
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
          intake: fields.intake ?? 'library',
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
      return {
        assetId: created.id,
        status: 'created' as const,
        intake: fields.intake ?? 'library',
      };
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const [race] = await ctx.db
        .select({ id: assets.id, intake: assets.intake })
        .from(assets)
        .where(and(eq(assets.ownerId, auth.user.id), eq(assets.checksumSha1, fields.checksum)));
      if (!race) throw error;
      setStatus(200);
      return { assetId: race.id, status: 'duplicate' as const, intake: race.intake };
    }
  },

  'assets.verify': async ({ ctx, auth, body }): Promise<AssetVerifyResponse> => {
    const status = await ctx.library.status();
    if (status.state !== 'ok') {
      throw new ApiError('library_unavailable', status.message, { details: { library: status } });
    }
    const checksums = body.items.map((item) => item.checksum);
    const rows = await ctx.db
      .select({
        assetId: assets.id,
        checksum: assets.checksumSha1,
        intake: assets.intake,
        file: files,
      })
      .from(assets)
      .innerJoin(files, eq(files.id, assets.fileId))
      .where(and(eq(assets.ownerId, auth.user.id), inArray(assets.checksumSha1, checksums)));
    const byChecksum = new Map(rows.map((row) => [row.checksum, row]));
    const results: AssetVerifyResponse['results'] = [];
    for (const item of body.items) {
      const row = byChecksum.get(item.checksum);
      if (!row || row.intake !== 'library') {
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
      .where(
        and(
          eq(assets.ownerId, auth.user.id),
          eq(assets.intake, 'library'),
          inArray(assets.id, [...owned]),
        ),
      )
      .returning({ id: assets.id });
    if (body.isTrashed === false) {
      await syncAlbumRulesForAssets(
        ctx.db,
        updated.map((row) => row.id),
      );
    }
    return { updated: updated.length };
  },

  'assets.emptyTrash': async ({ ctx, auth }) => ({
    deleted: await deleteTrashedAssets(ctx.db, { ownerId: auth.user.id }),
  }),

  'assets.review': async ({ ctx, auth, query }) => {
    const where = and(
      eq(assets.ownerId, auth.user.id),
      eq(assets.intake, 'review'),
      isNull(assets.trashedAt),
    );
    const [counted] = await ctx.db
      .select({
        total: sql<number>`count(*)::int`,
        totalBytes: sql<number>`coalesce(sum(${files.sizeBytes}), 0)::float8`,
      })
      .from(assets)
      .innerJoin(files, eq(files.id, assets.fileId))
      .where(where);
    const offset = pageOffset(query.cursor);
    const rows = await ctx.db
      .select()
      .from(assets)
      .where(where)
      .orderBy(sql`${assets.capturedAt} desc nulls last`, desc(assets.id))
      .offset(offset)
      .limit(query.limit + 1);
    const page = rows.slice(0, query.limit);
    return {
      items: await toSummaries(ctx, auth.user.id, page),
      total: Number(counted?.total ?? 0),
      totalBytes: Number(counted?.totalBytes ?? 0),
      nextCursor: rows.length > query.limit ? String(offset + query.limit) : null,
    };
  },

  'assets.acceptAllReview': async ({ ctx, auth }) => {
    const updated = await ctx.db
      .update(assets)
      .set({
        intake: 'library',
        processingSteps: sql`${assets.processingSteps} || '{"faces":"pending"}'::jsonb`,
      })
      .where(
        and(
          eq(assets.ownerId, auth.user.id),
          eq(assets.intake, 'review'),
          isNull(assets.trashedAt),
        ),
      )
      .returning({ id: assets.id });
    for (const row of updated) await scheduleRecognition(ctx, row.id);
    return { updated: updated.length };
  },

  'assets.acceptReview': async ({ ctx, auth, body }) => {
    const updated = await ctx.db
      .update(assets)
      .set({
        intake: 'library',
        processingSteps: sql`${assets.processingSteps} || '{"faces":"pending"}'::jsonb`,
      })
      .where(
        and(
          eq(assets.ownerId, auth.user.id),
          eq(assets.intake, 'review'),
          isNull(assets.trashedAt),
          inArray(assets.id, body.ids),
        ),
      )
      .returning({ id: assets.id });
    for (const row of updated) await scheduleRecognition(ctx, row.id);
    return { updated: updated.length };
  },

  'assets.rejectReview': async ({ ctx, auth, body }) => {
    const deleted = await ctx.db.transaction(async (tx) => {
      const rows = await tx
        .select({ id: assets.id, checksum: assets.checksumSha1 })
        .from(assets)
        .where(
          and(
            eq(assets.ownerId, auth.user.id),
            eq(assets.intake, 'review'),
            inArray(assets.id, body.ids),
          ),
        );
      if (rows.length === 0) return 0;
      await tx
        .insert(rejectedChecksums)
        .values(rows.map((row) => ({ ownerId: auth.user.id, sha1: row.checksum })))
        .onConflictDoNothing();
      await tx.delete(assets).where(
        inArray(
          assets.id,
          rows.map((row) => row.id),
        ),
      );
      return rows.length;
    });
    return { deleted };
  },

  'assets.cleanup': async ({ ctx, auth, query }) => {
    const where = cleanupWhere(auth.user.id, query.filter, query.maxFaces);
    const [counted] = await ctx.db
      .select({
        total: sql<number>`count(*)::int`,
        totalBytes: sql<number>`coalesce(sum(${files.sizeBytes}), 0)::float8`,
      })
      .from(assets)
      .innerJoin(files, eq(files.id, assets.fileId))
      .where(where);
    const offset = pageOffset(query.cursor);
    const rows = await ctx.db
      .select()
      .from(assets)
      .where(where)
      .orderBy(sql`${assets.capturedAt} desc nulls last`, desc(assets.id))
      .offset(offset)
      .limit(query.limit + 1);
    const page = rows.slice(0, query.limit);
    return {
      items: await toSummaries(ctx, auth.user.id, page),
      total: Number(counted?.total ?? 0),
      totalBytes: Number(counted?.totalBytes ?? 0),
      nextCursor: rows.length > query.limit ? String(offset + query.limit) : null,
    };
  },

  'assets.cleanupTrash': async ({ ctx, auth, body }) => {
    const updated = await ctx.db
      .update(assets)
      .set({ trashedAt: sql`coalesce(${assets.trashedAt}, now())` })
      .where(cleanupWhere(auth.user.id, body.filter, body.maxFaces))
      .returning({ id: assets.id });
    return { updated: updated.length };
  },
};

/** Library photos worth a cleanup pass. Favorites stay where they are. */
function cleanupWhere(ownerId: string, filter: CleanupFilter, maxFaces: number): SQL | undefined {
  const base = and(
    eq(assets.ownerId, ownerId),
    eq(assets.intake, 'library'),
    isNull(assets.trashedAt),
    eq(assets.isFavorite, false),
  );
  if (filter === 'screenshots') return and(base, ilike(assets.originalFilename, '%screenshot%'));
  const person = (extra: SQL) => sql`exists (
    select 1 from faces f
    join people p on p.id = f.person_id
    where f.asset_id = ${assets.id} and f.ignored = false and ${extra}
  )`;
  if (filter === 'unimportant') {
    return and(base, person(sql`p.important = false`), sql`not ${person(sql`p.important = true`)}`);
  }
  return and(
    base,
    person(sql`p.face_count <= ${maxFaces}`),
    sql`not ${person(sql`p.face_count > ${maxFaces}`)}`,
  );
}

function pageOffset(cursor: string | undefined): number {
  if (!cursor) return 0;
  const value = Number(cursor);
  return Number.isInteger(value) && value >= 0 ? value : 0;
}
