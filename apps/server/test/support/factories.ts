import { randomBytes } from 'node:crypto';
import type { AssetType, UserRole } from '@ngp/shared';
import type { Hono } from 'hono';
import { expect } from 'vitest';
import { hashPassword } from '../../src/auth/passwords';
import type { AppContext } from '../../src/context';
import {
  albumAssets,
  albumMembers,
  albumRules,
  albums,
  assetFiles,
  assets,
  faces,
  people,
  users,
  type AssetRow,
  type UserRow,
} from '../../src/db/schema';
import type { AppEnv } from '../../src/http/types';
import { TestClient } from './client';

export const DEFAULT_PASSWORD = 'correct horse battery';
let defaultHash: Promise<string> | undefined;

export async function createUser(
  ctx: AppContext,
  input: {
    email: string;
    name?: string;
    role?: UserRole;
    password?: string;
    quotaBytes?: number | null;
  },
): Promise<UserRow> {
  const passwordHash = input.password
    ? await hashPassword(input.password)
    : await (defaultHash ??= hashPassword(DEFAULT_PASSWORD));
  const [user] = await ctx.db
    .insert(users)
    .values({
      email: input.email.toLowerCase(),
      name: input.name ?? input.email.split('@')[0]!,
      passwordHash,
      role: input.role ?? 'member',
      quotaBytes: input.quotaBytes ?? null,
    })
    .returning();
  return user!;
}

/** A browser signed in as the person. */
export async function signIn(
  app: Hono<AppEnv>,
  email: string,
  password = DEFAULT_PASSWORD,
): Promise<TestClient> {
  const client = new TestClient(app);
  const result = await client.call('auth.login', { body: { email, password } });
  expect(result.status, JSON.stringify(result.error)).toBe(200);
  return client;
}

/** A phone paired through a pairing code created by the signed-in browser. */
export async function pairPhone(
  browser: TestClient,
  name = 'Pixel 9',
): Promise<{ phone: TestClient; deviceId: string }> {
  const code = await browser.call('devices.createPairingCode');
  expect(code.status).toBe(201);
  const paired = await new TestClient(browser.app).call('devices.pair', {
    body: { method: 'code', code: code.data.code, device: { name, platform: 'android' } },
  });
  expect(paired.status, JSON.stringify(paired.error)).toBe(201);
  return { phone: browser.withToken(paired.data.deviceToken), deviceId: paired.data.deviceId };
}

export async function insertAsset(
  ctx: AppContext,
  ownerId: string,
  options: {
    bytes?: Buffer;
    type?: AssetType;
    filename?: string;
    mimeType?: string;
    capturedAt?: Date;
    trashed?: boolean;
  } = {},
): Promise<AssetRow> {
  const bytes = options.bytes ?? randomBytes(256);
  const mimeType = options.mimeType ?? (options.type === 'video' ? 'video/mp4' : 'image/jpeg');
  const { file } = await ctx.files.ingest(bytes, { mimeType });
  const capturedAt = options.capturedAt ?? new Date('2024-07-14T10:30:00Z');
  const [asset] = await ctx.db
    .insert(assets)
    .values({
      ownerId,
      fileId: file.id,
      type: options.type ?? 'image',
      checksumSha1: file.sha1,
      originalFilename: options.filename ?? `IMG_${file.sha1.slice(0, 8)}.jpg`,
      mimeType,
      capturedAt,
      localDate: capturedAt.toISOString().slice(0, 10),
      trashedAt: options.trashed ? new Date() : null,
    })
    .returning();
  return asset!;
}

export async function insertDerivedFile(
  ctx: AppContext,
  assetId: string,
  kind: 'thumbnail' | 'preview' | 'playback',
  bytes: Buffer = randomBytes(64),
) {
  const mimeType = kind === 'playback' ? 'video/mp4' : 'image/webp';
  const { file } = await ctx.files.ingest(bytes, { mimeType });
  const [row] = await ctx.db
    .insert(assetFiles)
    .values({ assetId, kind, fileId: file.id, mimeType })
    .returning();
  return row!;
}

export async function insertPerson(ctx: AppContext, ownerId: string, name: string | null) {
  const [person] = await ctx.db.insert(people).values({ ownerId, name }).returning();
  return person!;
}

export async function insertFace(
  ctx: AppContext,
  input: { assetId: string; ownerId: string; personId?: string | null },
) {
  const [face] = await ctx.db
    .insert(faces)
    .values({
      assetId: input.assetId,
      ownerId: input.ownerId,
      personId: input.personId ?? null,
      boxX: 0.4,
      boxY: 0.2,
      boxWidth: 0.2,
      boxHeight: 0.25,
      quality: 0.9,
      model: 'test',
    })
    .returning();
  return face!;
}

export async function insertAlbum(ctx: AppContext, ownerId: string, title: string, isLive = false) {
  const [album] = await ctx.db.insert(albums).values({ ownerId, title, isLive }).returning();
  return album!;
}

export async function addAlbumMember(
  ctx: AppContext,
  albumId: string,
  userId: string,
  options: { accepted?: boolean; role?: 'viewer' | 'contributor'; showInTimeline?: boolean } = {},
) {
  await ctx.db.insert(albumMembers).values({
    albumId,
    userId,
    role: options.role ?? 'viewer',
    showInTimeline: options.showInTimeline ?? false,
    acceptedAt: options.accepted === false ? null : new Date(),
  });
}

export async function addAlbumAsset(
  ctx: AppContext,
  albumId: string,
  assetId: string,
  addedById: string,
) {
  await ctx.db.insert(albumAssets).values({ albumId, assetId, addedById });
}

export async function addAlbumRule(
  ctx: AppContext,
  albumId: string,
  userId: string,
  personId: string,
) {
  const [rule] = await ctx.db.insert(albumRules).values({ albumId, userId, personId }).returning();
  return rule!;
}
