/**
 * Database schema (plan section B1). Migrations live in `apps/server/drizzle/`:
 * generate with `pnpm db:generate` after editing this file.
 *
 * Constraints Drizzle can't express are in hand-written migrations (see `drizzle/*_integrity.sql`):
 * - `faces (person_id, owner_id) -> people (id, owner_id) ON DELETE SET NULL (person_id)`
 * - `assets (version_of_id, owner_id) -> assets (id, owner_id) ON DELETE SET NULL (version_of_id)`
 * - triggers that keep `files.ref_count` equal to the number of `assets` and `asset_files` rows
 *   pointing at each file.
 */
import { CLIP_EMBEDDING_DIMENSIONS, FACE_EMBEDDING_DIMENSIONS } from '@ngp/shared';
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  date,
  doublePrecision,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  real,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  vector,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';

const tz = { withTimezone: true } as const;
const createdAt = () => timestamp('created_at', tz).notNull().defaultNow();
const updatedAt = () =>
  timestamp('updated_at', tz)
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());
const id = () => uuid('id').primaryKey().defaultRandom();

export const userRole = pgEnum('user_role', ['admin', 'member']);
export const devicePlatform = pgEnum('device_platform', ['android', 'ios', 'web', 'other']);
export const assetType = pgEnum('asset_type', ['image', 'video']);
export const processingState = pgEnum('processing_state', ['pending', 'processing', 'ready', 'failed']);
export const assetFileKind = pgEnum('asset_file_kind', ['thumbnail', 'preview', 'playback']);
export const tagSource = pgEnum('tag_source', ['clip', 'rule', 'manual']);
export const albumMemberRole = pgEnum('album_member_role', ['viewer', 'contributor']);
export const albumAssetSource = pgEnum('album_asset_source', ['manual', 'rule']);
export const storageMode = pgEnum('storage_mode', ['original', 'storage_saver']);

/** Single row (id = 1): this server's identity and admin-editable settings. */
export const serverConfig = pgTable(
  'server_config',
  {
    id: smallint('id').primaryKey().default(1),
    serverId: uuid('server_id').notNull().defaultRandom(),
    name: text('name').notNull(),
    homeUrl: text('home_url'),
    remoteUrl: text('remote_url'),
    signingSecret: text('signing_secret').notNull(),
    /** Set once the library folder has been claimed with a marker file. */
    libraryInitializedAt: timestamp('library_initialized_at', tz),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [check('server_config_singleton', sql`${t.id} = 1`)],
);

// ---------------------------------------------------------------------------------------------
// Accounts, sessions, devices
// ---------------------------------------------------------------------------------------------

export const users = pgTable(
  'users',
  {
    id: id(),
    /** Stored lower-cased. */
    email: text('email').notNull(),
    name: text('name').notNull(),
    passwordHash: text('password_hash').notNull(),
    role: userRole('role').notNull().default('member'),
    /** `null` means unlimited. */
    quotaBytes: bigint('quota_bytes', { mode: 'number' }),
    disabledAt: timestamp('disabled_at', tz),
    invitedById: uuid('invited_by_id').references((): AnyPgColumn => users.id, {
      onDelete: 'set null',
    }),
    lastLoginAt: timestamp('last_login_at', tz),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('users_email_key').on(sql`lower(${t.email})`)],
);

export const sessions = pgTable(
  'sessions',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull().unique(),
    userAgent: text('user_agent'),
    ip: text('ip'),
    createdAt: createdAt(),
    lastSeenAt: timestamp('last_seen_at', tz).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', tz).notNull(),
  },
  (t) => [index('sessions_user_id_idx').on(t.userId), index('sessions_expires_at_idx').on(t.expiresAt)],
);

export const invites = pgTable(
  'invites',
  {
    id: id(),
    tokenHash: text('token_hash').notNull().unique(),
    /** When set, the invite can only be accepted with this (lower-cased) email. */
    email: text('email'),
    name: text('name'),
    role: userRole('role').notNull().default('member'),
    quotaBytes: bigint('quota_bytes', { mode: 'number' }),
    createdById: uuid('created_by_id').references(() => users.id, { onDelete: 'set null' }),
    acceptedById: uuid('accepted_by_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    expiresAt: timestamp('expires_at', tz).notNull(),
    acceptedAt: timestamp('accepted_at', tz),
    revokedAt: timestamp('revoked_at', tz),
  },
  (t) => [index('invites_created_at_idx').on(t.createdAt)],
);

export const devices = pgTable(
  'devices',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    platform: devicePlatform('platform').notNull(),
    model: text('model'),
    osVersion: text('os_version'),
    appVersion: text('app_version'),
    tokenHash: text('token_hash').notNull().unique(),
    createdAt: createdAt(),
    lastSeenAt: timestamp('last_seen_at', tz),
    lastIp: text('last_ip'),
    revokedAt: timestamp('revoked_at', tz),
  },
  (t) => [index('devices_user_id_idx').on(t.userId)],
);

export const pairingCodes = pgTable(
  'pairing_codes',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    codeHash: text('code_hash').notNull().unique(),
    createdAt: createdAt(),
    expiresAt: timestamp('expires_at', tz).notNull(),
    usedAt: timestamp('used_at', tz),
    deviceId: uuid('device_id').references(() => devices.id, { onDelete: 'set null' }),
  },
  (t) => [index('pairing_codes_user_id_idx').on(t.userId)],
);

// ---------------------------------------------------------------------------------------------
// Files and assets
// ---------------------------------------------------------------------------------------------

/**
 * Content-addressed blobs. Stored once by SHA-256 across all accounts; `sha1` is what phones
 * send. `ref_count` is maintained by triggers on `assets` and `asset_files`.
 */
export const files = pgTable(
  'files',
  {
    id: id(),
    sha256: text('sha256').notNull().unique(),
    sha1: text('sha1').notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    storageKey: text('storage_key').notNull(),
    mimeType: text('mime_type'),
    refCount: integer('ref_count').notNull().default(0),
    createdAt: createdAt(),
    /** Last time the stored bytes were re-hashed and matched. */
    verifiedAt: timestamp('verified_at', tz),
  },
  (t) => [
    index('files_sha1_idx').on(t.sha1),
    index('files_unreferenced_idx').on(t.createdAt).where(sql`${t.refCount} = 0`),
    check('files_ref_count_nonnegative', sql`${t.refCount} >= 0`),
    check('files_sha256_hex', sql`${t.sha256} ~ '^[0-9a-f]{64}$'`),
    check('files_sha1_hex', sql`${t.sha1} ~ '^[0-9a-f]{40}$'`),
  ],
);

export const assets = pgTable(
  'assets',
  {
    id: id(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    fileId: uuid('file_id')
      .notNull()
      .references(() => files.id, { onDelete: 'restrict' }),
    type: assetType('type').notNull(),
    /** SHA-1 of the original, unique per owner: the per-account dedupe key phones check against. */
    checksumSha1: text('checksum_sha1').notNull(),
    originalFilename: text('original_filename').notNull(),
    mimeType: text('mime_type'),
    deviceId: uuid('device_id').references(() => devices.id, { onDelete: 'set null' }),
    deviceAssetId: text('device_asset_id'),

    /** The instant it was taken. */
    capturedAt: timestamp('captured_at', tz),
    /** Wall-clock time where it was taken. */
    capturedLocal: timestamp('captured_local', { withTimezone: false }),
    /** IANA zone or UTC offset, e.g. `Asia/Jerusalem` or `+03:00`. */
    timezone: text('timezone'),
    /** Local calendar date, used for day grouping and "On this day". */
    localDate: date('local_date', { mode: 'string' }),
    fileModifiedAt: timestamp('file_modified_at', tz),

    latitude: doublePrecision('latitude'),
    longitude: doublePrecision('longitude'),
    altitude: doublePrecision('altitude'),
    city: text('city'),
    region: text('region'),
    country: text('country'),
    countryCode: text('country_code'),

    cameraMake: text('camera_make'),
    cameraModel: text('camera_model'),
    lensModel: text('lens_model'),
    /** Other extracted metadata (exposure, ISO, focal length, ...). */
    exif: jsonb('exif').$type<Record<string, unknown>>(),

    /** Oriented (display) dimensions. */
    width: integer('width'),
    height: integer('height'),
    durationMs: integer('duration_ms'),
    thumbhash: text('thumbhash'),

    isFavorite: boolean('is_favorite').notNull().default(false),
    isArchived: boolean('is_archived').notNull().default(false),
    trashedAt: timestamp('trashed_at', tz),
    /** Edited copies point at their original (same owner, enforced by a composite FK). */
    versionOfId: uuid('version_of_id'),

    processingState: processingState('processing_state').notNull().default('pending'),
    /** Per-step progress, e.g. `{ "metadata": "done", "thumbnails": "done", "faces": "failed" }`. */
    processingSteps: jsonb('processing_steps')
      .$type<Record<string, string>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('assets_owner_checksum_key').on(t.ownerId, t.checksumSha1),
    unique('assets_id_owner_key').on(t.id, t.ownerId),
    index('assets_owner_captured_idx').on(t.ownerId, t.capturedAt.desc()),
    index('assets_owner_local_date_idx').on(t.ownerId, t.localDate),
    index('assets_file_id_idx').on(t.fileId),
    index('assets_version_of_idx').on(t.versionOfId),
    index('assets_trashed_idx').on(t.trashedAt).where(sql`${t.trashedAt} is not null`),
    check('assets_checksum_sha1_hex', sql`${t.checksumSha1} ~ '^[0-9a-f]{40}$'`),
  ],
);

/** Derived copies: grid thumbnail, viewer preview, video playback copy. */
export const assetFiles = pgTable(
  'asset_files',
  {
    id: id(),
    assetId: uuid('asset_id')
      .notNull()
      .references(() => assets.id, { onDelete: 'cascade' }),
    kind: assetFileKind('kind').notNull(),
    fileId: uuid('file_id')
      .notNull()
      .references(() => files.id, { onDelete: 'restrict' }),
    width: integer('width'),
    height: integer('height'),
    mimeType: text('mime_type'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('asset_files_asset_kind_key').on(t.assetId, t.kind),
    index('asset_files_file_id_idx').on(t.fileId),
  ],
);

/** CLIP image embedding per asset, for semantic search and zero-shot tags. */
export const assetEmbeddings = pgTable(
  'asset_embeddings',
  {
    assetId: uuid('asset_id')
      .primaryKey()
      .references(() => assets.id, { onDelete: 'cascade' }),
    model: text('model').notNull(),
    embedding: vector('embedding', { dimensions: CLIP_EMBEDDING_DIMENSIONS }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('asset_embeddings_embedding_idx').using('hnsw', t.embedding.op('vector_cosine_ops'))],
);

// ---------------------------------------------------------------------------------------------
// Faces and people (per account)
// ---------------------------------------------------------------------------------------------

export const people = pgTable(
  'people',
  {
    id: id(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name'),
    coverFaceId: uuid('cover_face_id').references((): AnyPgColumn => faces.id, {
      onDelete: 'set null',
    }),
    isHidden: boolean('is_hidden').notNull().default(false),
    hideFromMemories: boolean('hide_from_memories').notNull().default(false),
    faceCount: integer('face_count').notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('people_owner_idx').on(t.ownerId), unique('people_id_owner_key').on(t.id, t.ownerId)],
);

export const faces = pgTable(
  'faces',
  {
    id: id(),
    assetId: uuid('asset_id').notNull(),
    /** The library the face belongs to (always the asset's owner). */
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Box normalized to the oriented image, 0..1 from the top-left corner. */
    boxX: real('box_x').notNull(),
    boxY: real('box_y').notNull(),
    boxWidth: real('box_width').notNull(),
    boxHeight: real('box_height').notNull(),
    /** Five-point landmarks as normalized `[x, y]` pairs. */
    landmarks: jsonb('landmarks').$type<[number, number][]>(),
    detectionScore: real('detection_score'),
    /** Size, sharpness, and pose combined; low-quality faces never become people. */
    quality: real('quality'),
    embedding: vector('embedding', { dimensions: FACE_EMBEDDING_DIMENSIONS }),
    model: text('model'),
    /** Same-owner person, enforced by a composite FK in the integrity migration. */
    personId: uuid('person_id'),
    /** Set when someone assigned the person by hand; re-clustering never changes it. */
    assignedManually: boolean('assigned_manually').notNull().default(false),
    /** "Not a face" or "don't use this face". */
    ignored: boolean('ignored').notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    foreignKey({
      name: 'faces_asset_owner_fk',
      columns: [t.assetId, t.ownerId],
      foreignColumns: [assets.id, assets.ownerId],
    }).onDelete('cascade'),
    index('faces_asset_idx').on(t.assetId),
    index('faces_owner_person_idx').on(t.ownerId, t.personId),
    index('faces_embedding_idx').using('hnsw', t.embedding.op('vector_cosine_ops')),
  ],
);

/** "Not this person" corrections that clustering must respect. */
export const faceFeedback = pgTable(
  'face_feedback',
  {
    id: id(),
    faceId: uuid('face_id')
      .notNull()
      .references(() => faces.id, { onDelete: 'cascade' }),
    personId: uuid('person_id')
      .notNull()
      .references(() => people.id, { onDelete: 'cascade' }),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull().default('not_this_person'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('face_feedback_face_person_key').on(t.faceId, t.personId)],
);

// ---------------------------------------------------------------------------------------------
// Tags
// ---------------------------------------------------------------------------------------------

/** Shared vocabulary (dog, beach, food, screenshot, ...). */
export const tags = pgTable('tags', {
  id: id(),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  /** CLIP text prompt for zero-shot tagging. */
  prompt: text('prompt'),
  createdAt: createdAt(),
});

export const assetTags = pgTable(
  'asset_tags',
  {
    assetId: uuid('asset_id')
      .notNull()
      .references(() => assets.id, { onDelete: 'cascade' }),
    tagId: uuid('tag_id')
      .notNull()
      .references(() => tags.id, { onDelete: 'cascade' }),
    confidence: real('confidence').notNull(),
    source: tagSource('source').notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.assetId, t.tagId] }), index('asset_tags_tag_idx').on(t.tagId)],
);

// ---------------------------------------------------------------------------------------------
// Albums and sharing
// ---------------------------------------------------------------------------------------------

export const albums = pgTable(
  'albums',
  {
    id: id(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    description: text('description'),
    coverAssetId: uuid('cover_asset_id').references(() => assets.id, { onDelete: 'set null' }),
    /** Live albums collect photos of linked people automatically (see `album_rules`). */
    isLive: boolean('is_live').notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('albums_owner_idx').on(t.ownerId)],
);

export const albumMembers = pgTable(
  'album_members',
  {
    albumId: uuid('album_id')
      .notNull()
      .references(() => albums.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: albumMemberRole('role').notNull().default('viewer'),
    /** The member's own switch: show this album's photos in their timeline, search, and memories. */
    showInTimeline: boolean('show_in_timeline').notNull().default(false),
    invitedById: uuid('invited_by_id').references(() => users.id, { onDelete: 'set null' }),
    invitedAt: timestamp('invited_at', tz).notNull().defaultNow(),
    /** `null` while the invitation is pending; pending members can't see the photos. */
    acceptedAt: timestamp('accepted_at', tz),
  },
  (t) => [primaryKey({ columns: [t.albumId, t.userId] }), index('album_members_user_idx').on(t.userId)],
);

/** Each member links their own person to a live album, optionally from a start date. */
export const albumRules = pgTable(
  'album_rules',
  {
    id: id(),
    albumId: uuid('album_id')
      .notNull()
      .references(() => albums.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    personId: uuid('person_id').notNull(),
    startDate: date('start_date', { mode: 'string' }),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      name: 'album_rules_person_owner_fk',
      columns: [t.personId, t.userId],
      foreignColumns: [people.id, people.ownerId],
    }).onDelete('cascade'),
    uniqueIndex('album_rules_album_person_key').on(t.albumId, t.personId),
    index('album_rules_person_idx').on(t.personId),
  ],
);

/** Photos are referenced, never copied; they stay owned by whoever uploaded them. */
export const albumAssets = pgTable(
  'album_assets',
  {
    albumId: uuid('album_id')
      .notNull()
      .references(() => albums.id, { onDelete: 'cascade' }),
    assetId: uuid('asset_id')
      .notNull()
      .references(() => assets.id, { onDelete: 'cascade' }),
    addedById: uuid('added_by_id').references(() => users.id, { onDelete: 'set null' }),
    source: albumAssetSource('source').notNull().default('manual'),
    ruleId: uuid('rule_id').references(() => albumRules.id, { onDelete: 'set null' }),
    addedAt: timestamp('added_at', tz).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.albumId, t.assetId] }), index('album_assets_asset_idx').on(t.assetId)],
);

// ---------------------------------------------------------------------------------------------
// Memories and storage policies
// ---------------------------------------------------------------------------------------------

export const memories = pgTable(
  'memories',
  {
    id: id(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** `on_this_day` for now. */
    kind: text('kind').notNull(),
    memoryDate: date('memory_date', { mode: 'string' }).notNull(),
    title: text('title').notNull(),
    subtitle: text('subtitle'),
    coverAssetId: uuid('cover_asset_id').references(() => assets.id, { onDelete: 'set null' }),
    seenAt: timestamp('seen_at', tz),
    dismissedAt: timestamp('dismissed_at', tz),
    notifiedAt: timestamp('notified_at', tz),
    createdAt: createdAt(),
  },
  (t) => [index('memories_owner_date_idx').on(t.ownerId, t.memoryDate)],
);

export const memoryAssets = pgTable(
  'memory_assets',
  {
    memoryId: uuid('memory_id')
      .notNull()
      .references(() => memories.id, { onDelete: 'cascade' }),
    assetId: uuid('asset_id')
      .notNull()
      .references(() => assets.id, { onDelete: 'cascade' }),
    position: integer('position').notNull(),
  },
  (t) => [primaryKey({ columns: [t.memoryId, t.assetId] }), index('memory_assets_asset_idx').on(t.assetId)],
);

/** Per account and media type: keep originals, or re-encode with storage saver. */
export const storagePolicies = pgTable(
  'storage_policies',
  {
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    mediaType: assetType('media_type').notNull(),
    mode: storageMode('mode').notNull().default('original'),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.ownerId, t.mediaType] })],
);

export type UserRow = typeof users.$inferSelect;
export type SessionRow = typeof sessions.$inferSelect;
export type InviteRow = typeof invites.$inferSelect;
export type DeviceRow = typeof devices.$inferSelect;
export type PairingCodeRow = typeof pairingCodes.$inferSelect;
export type FileRow = typeof files.$inferSelect;
export type AssetRow = typeof assets.$inferSelect;
export type AssetFileRow = typeof assetFiles.$inferSelect;
export type PersonRow = typeof people.$inferSelect;
export type FaceRow = typeof faces.$inferSelect;
export type AlbumRow = typeof albums.$inferSelect;
export type ServerConfigRow = typeof serverConfig.$inferSelect;
