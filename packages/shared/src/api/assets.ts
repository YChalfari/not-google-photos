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
  QueryBool,
  Sha1Hex,
  UserRef,
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

export const AssetCheckResponse = z
  .object({
    /** Checksums not in your library yet: upload these. */
    missing: z.array(Sha1Hex),
    /** Already in your library: record the server asset id and skip the upload. */
    present: z.array(z.object({ checksum: Sha1Hex, assetId: Id })),
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
  })
  .meta({ id: 'AssetUploadFields' });
export type AssetUploadFields = z.input<typeof AssetUploadFields>;

export const AssetUploadResponse = z
  .object({
    assetId: Id,
    /** `duplicate`: the same bytes were already in your library; nothing new was stored. */
    status: z.enum(['created', 'duplicate']),
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
});
