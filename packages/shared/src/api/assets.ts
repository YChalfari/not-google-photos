import { z } from 'zod';
import { MAX_CHECK_BATCH, MAX_VERIFY_BATCH } from '../constants';
import { defineEndpoints } from '../contract/define';
import {
  AssetType,
  Bytes,
  Id,
  IdParams,
  IsoDateTime,
  LocalDate,
  PageQuery,
  QueryBool,
  Sha1Hex,
  UserRef,
  paginated,
} from '../primitives';

/** What grids, search results, albums, and memories show for each photo or video. */
export const AssetSummary = z
  .object({
    id: Id,
    type: AssetType,
    ownerId: Id,
    capturedAt: IsoDateTime.nullable(),
    localDate: LocalDate.nullable(),
    width: z.number().int().positive().nullable(),
    height: z.number().int().positive().nullable(),
    durationMs: z.number().int().nonnegative().nullable(),
    isFavorite: z.boolean(),
    /** Base64 ThumbHash placeholder shown while the thumbnail loads. */
    thumbhash: z.string().nullable(),
    thumbnailUrl: z.string().nullable(),
    previewUrl: z.string().nullable(),
  })
  .meta({ id: 'AssetSummary' });
export type AssetSummary = z.infer<typeof AssetSummary>;

export const FaceBox = z
  .object({
    /** Normalized to the oriented image: 0..1 from the top-left corner. */
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
    width: z.number().min(0).max(1),
    height: z.number().min(0).max(1),
  })
  .meta({ id: 'FaceBox' });

export const AssetDetail = AssetSummary.extend({
  originalFilename: z.string(),
  mimeType: z.string().nullable(),
  sizeBytes: Bytes,
  timezone: z.string().nullable(),
  isArchived: z.boolean(),
  trashedAt: IsoDateTime.nullable(),
  owner: UserRef,
  location: z
    .object({
      latitude: z.number(),
      longitude: z.number(),
      city: z.string().nullable(),
      country: z.string().nullable(),
    })
    .nullable(),
  camera: z
    .object({
      make: z.string().nullable(),
      model: z.string().nullable(),
      lens: z.string().nullable(),
    })
    .nullable(),
  /** Faces you can see on this asset (your own library's, or a person shared with you). */
  faces: z.array(
    z.object({
      id: Id,
      box: FaceBox,
      person: z.object({ id: Id, name: z.string().nullable() }).nullable(),
    }),
  ),
  tags: z.array(z.object({ name: z.string(), confidence: z.number().min(0).max(1) })),
  originalUrl: z.string().nullable(),
  playbackUrl: z.string().nullable(),
}).meta({ id: 'AssetDetail' });
export type AssetDetail = z.infer<typeof AssetDetail>;

export const AssetCheckRequest = z.object({
  checksums: z.array(Sha1Hex).min(1).max(MAX_CHECK_BATCH),
});
export type AssetCheckRequest = z.input<typeof AssetCheckRequest>;

export const AssetIntake = z.enum(['library', 'review']);
export type AssetIntake = z.infer<typeof AssetIntake>;

export const AssetCheckResponse = z
  .object({
    /** Checksums not on the server yet: upload these. */
    missing: z.array(Sha1Hex),
    /** Already in the library: record the server asset id and skip the upload. */
    present: z.array(z.object({ checksum: Sha1Hex, assetId: Id })),
    /** Uploaded, still waiting in the holding area. Do not upload again and do not delete the phone copy. */
    held: z.array(z.object({ checksum: Sha1Hex, assetId: Id })),
    /** The owner said no. Do not upload again. */
    rejected: z.array(Sha1Hex),
  })
  .meta({ id: 'AssetCheckResponse' });
export type AssetCheckResponse = z.infer<typeof AssetCheckResponse>;

/**
 * Text fields of the `multipart/form-data` upload. Send them before the `file` part so the
 * server can validate while streaming. Numbers and booleans arrive as strings.
 */
export const AssetUploadFields = z
  .object({
    /** SHA-1 of the file bytes (hex). The upload is rejected if the bytes don't match. */
    checksum: Sha1Hex,
    /** Original file name on the device, e.g. `PXL_20261026_085200123.jpg`. */
    filename: z.string().trim().min(1).max(255),
    /** Capture time from the device (MediaStore DATE_TAKEN). The server prefers EXIF when present. */
    capturedAt: IsoDateTime.optional(),
    modifiedAt: IsoDateTime.optional(),
    /** The device's own id for the item (MediaStore id), for support and re-linking. */
    deviceAssetId: z.string().trim().max(255).optional(),
    durationMs: z.coerce.number().int().nonnegative().optional(),
    isFavorite: QueryBool.optional(),
    /** Server asset id of the original when this file is an edited copy. */
    versionOf: Id.optional(),
    /**
     * `review` stores the file in the holding area instead of the library.
     * Omitted means `library`.
     */
    intake: AssetIntake.optional(),
  })
  .meta({ id: 'AssetUploadFields' });
export type AssetUploadFields = z.input<typeof AssetUploadFields>;

export const AssetUploadResponse = z
  .object({
    assetId: Id.nullable(),
    /**
     * `duplicate`: the same bytes were already stored; nothing new was kept.
     * `rejected`: these bytes were refused before and were not stored again.
     */
    status: z.enum(['created', 'duplicate', 'rejected']),
    /** Where the stored asset sits. Null when `status` is `rejected`. */
    intake: AssetIntake.nullable(),
  })
  .meta({ id: 'AssetUploadResponse' });
export type AssetUploadResponse = z.infer<typeof AssetUploadResponse>;

export const AssetVerifyRequest = z.object({
  items: z
    .array(z.object({ checksum: Sha1Hex, size: Bytes }))
    .min(1)
    .max(MAX_VERIFY_BATCH),
});
export type AssetVerifyRequest = z.input<typeof AssetVerifyRequest>;

export const AssetVerifyResponse = z
  .object({
    results: z.array(
      z.object({
        checksum: Sha1Hex,
        assetId: Id.nullable(),
        /**
         * `verified`: the stored file exists and its size and checksum were re-checked just now.
         * Only delete the phone's copy for `verified`.
         */
        status: z.enum(['verified', 'missing', 'mismatch']),
      }),
    ),
  })
  .meta({ id: 'AssetVerifyResponse' });
export type AssetVerifyResponse = z.infer<typeof AssetVerifyResponse>;

export const UpdateAssetsRequest = z
  .object({
    ids: z.array(Id).min(1).max(1000),
    isFavorite: z.boolean().optional(),
    isArchived: z.boolean().optional(),
    /** `true` moves to the trash (kept 30 days), `false` restores. */
    isTrashed: z.boolean().optional(),
  })
  .refine(
    (value) =>
      value.isFavorite !== undefined ||
      value.isArchived !== undefined ||
      value.isTrashed !== undefined,
    { message: 'Nothing to update' },
  );

export const ReviewAssetIds = z.object({
  ids: z.array(Id).min(1).max(1000),
});

export const CleanupFilter = z.enum(['screenshots', 'unimportant', 'rare']);
export type CleanupFilter = z.infer<typeof CleanupFilter>;

export const CleanupQuery = PageQuery.extend({
  filter: CleanupFilter,
  /** Used by `rare`: people with at most this many faces. */
  maxFaces: z.coerce.number().int().min(1).max(100).default(3),
});

export const assetEndpoints = defineEndpoints({
  'assets.check': {
    method: 'POST',
    path: '/api/assets/check',
    auth: 'user',
    tag: 'assets',
    summary: 'Send checksums, get back the ones missing from your library',
    description: 'Per account: another person having the same file does not count as present.',
    body: AssetCheckRequest,
    response: AssetCheckResponse,
    stability: 'stable',
  },
  'assets.upload': {
    method: 'POST',
    path: '/api/assets',
    auth: 'user',
    tag: 'assets',
    summary: 'Upload one photo or video (streamed multipart: fields first, then `file`)',
    description:
      'Responds 201 with `status: created`, or 200 with `status: duplicate` when the bytes are already in your library.',
    body: AssetUploadFields,
    bodyKind: 'multipart',
    response: AssetUploadResponse,
    successStatus: 201,
    errors: [
      'checksum_mismatch',
      'library_unavailable',
      'quota_exceeded',
      'payload_too_large',
      'unsupported_media_type',
    ],
    stability: 'stable',
  },
  'assets.verify': {
    method: 'POST',
    path: '/api/assets/verify',
    auth: 'user',
    tag: 'assets',
    summary: 'Re-verify stored files before the phone deletes its copies',
    body: AssetVerifyRequest,
    response: AssetVerifyResponse,
    errors: ['library_unavailable'],
    stability: 'stable',
  },
  'assets.get': {
    method: 'GET',
    path: '/api/assets/:id',
    auth: 'user',
    tag: 'assets',
    summary: 'One asset with its details panel data',
    params: IdParams,
    response: AssetDetail,
    errors: ['not_found'],
    stability: 'draft',
  },
  'assets.update': {
    method: 'PATCH',
    path: '/api/assets',
    auth: 'user',
    tag: 'assets',
    summary: 'Favorite, archive, trash, or restore several of your assets',
    body: UpdateAssetsRequest,
    response: z.object({ updated: z.number().int().nonnegative() }),
    stability: 'draft',
  },
  'assets.emptyTrash': {
    method: 'POST',
    path: '/api/assets/trash/empty',
    auth: 'user',
    tag: 'assets',
    summary: 'Delete everything in your trash now',
    response: z.object({ deleted: z.number().int().nonnegative() }),
    stability: 'draft',
  },
  'assets.review': {
    method: 'GET',
    path: '/api/assets/review',
    auth: 'user',
    tag: 'assets',
    summary: 'Photos waiting in the holding area, newest first',
    query: PageQuery,
    response: paginated(AssetSummary).extend({
      total: z.number().int().nonnegative(),
      /** Combined size of every photo still waiting, not just this page. */
      totalBytes: z.number().nonnegative(),
    }),
    stability: 'draft',
  },
  'assets.acceptAllReview': {
    method: 'POST',
    path: '/api/assets/review/accept-all',
    auth: 'user',
    tag: 'assets',
    summary: 'Move every holding-area photo into the library',
    description: 'Includes photos that are not on the current page.',
    response: z.object({ updated: z.number().int().nonnegative() }),
    stability: 'draft',
  },
  'assets.acceptReview': {
    method: 'POST',
    path: '/api/assets/review/accept',
    auth: 'user',
    tag: 'assets',
    summary: 'Move holding-area photos into the library',
    body: ReviewAssetIds,
    response: z.object({ updated: z.number().int().nonnegative() }),
    stability: 'draft',
  },
  'assets.rejectReview': {
    method: 'POST',
    path: '/api/assets/review/reject',
    auth: 'user',
    tag: 'assets',
    summary: 'Delete holding-area photos and remember not to upload those bytes again',
    body: ReviewAssetIds,
    response: z.object({ deleted: z.number().int().nonnegative() }),
    stability: 'draft',
  },
  'assets.cleanup': {
    method: 'GET',
    path: '/api/assets/cleanup',
    auth: 'user',
    tag: 'assets',
    summary: 'Library photos that match a cleanup filter',
    description:
      'Favorites are left out. `unimportant` is photos of people who are not marked Important, and of nobody who is. `rare` is photos whose people each appear at most `maxFaces` times.',
    query: CleanupQuery,
    response: paginated(AssetSummary).extend({
      total: z.number().int().nonnegative(),
      totalBytes: z.number().nonnegative(),
    }),
    stability: 'draft',
  },
  'assets.cleanupTrash': {
    method: 'POST',
    path: '/api/assets/cleanup/trash',
    auth: 'user',
    tag: 'assets',
    summary: 'Move every library photo matching a cleanup filter to the trash',
    description: 'Favorites are left out. Trashed photos are kept for 30 days.',
    body: z.object({
      filter: CleanupFilter,
      maxFaces: z.number().int().min(1).max(100).default(3),
    }),
    response: z.object({ updated: z.number().int().nonnegative() }),
    stability: 'draft',
  },
});
