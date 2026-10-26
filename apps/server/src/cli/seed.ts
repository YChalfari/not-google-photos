import { eq, inArray, sql } from 'drizzle-orm';
import { hashPassword } from '../auth/passwords';
import { createContext } from '../context';
import { runMigrations } from '../db/migrate';
import {
  albumAssets,
  albumMembers,
  albums,
  assets,
  faces,
  people,
  serverConfig,
  storagePolicies,
  users,
} from '../db/schema';
import { loadDotEnv, parseEnv } from '../env';
import { createLogger } from '../logger';
import {
  SAMPLE_ACCOUNTS,
  SAMPLE_ALBUM,
  SAMPLE_PASSWORD,
  SAMPLE_PEOPLE,
  SAMPLE_SHOTS,
  faceEmbedding,
  renderSamplePhoto,
  type RenderedShot,
} from './sample-photos';

loadDotEnv();
const args = process.argv.slice(2);
if (args.some((arg) => arg !== '--reset')) {
  console.error('Usage: pnpm seed [--reset]');
  process.exit(1);
}
const reset = args.includes('--reset');

const env = parseEnv();
const log = createLogger(env);

await runMigrations(env.DATABASE_URL, log);
const ctx = await createContext(env, log);

try {
  const emails = Object.values(SAMPLE_ACCOUNTS).map((account) => account.email);
  const existing = await ctx.db
    .select({ id: users.id })
    .from(users)
    .where(inArray(users.email, emails));
  if (existing.length > 0 && !reset) {
    console.log(
      `Sample accounts are already in the database (${existing.length}). Run \`pnpm seed --reset\` to recreate them.`,
    );
    process.exit(0);
  }
  if (reset && existing.length > 0) {
    await ctx.db.delete(users).where(inArray(users.email, emails));
    const removed = await ctx.files.collectGarbage({ graceMs: 0 });
    log.info({ removed }, 'Cleared the previous sample library');
  }

  const passwordHash = await hashPassword(SAMPLE_PASSWORD);
  const [alex] = await ctx.db
    .insert(users)
    .values({ ...SAMPLE_ACCOUNTS.alex, passwordHash })
    .returning();
  const [sam] = await ctx.db
    .insert(users)
    .values({ ...SAMPLE_ACCOUNTS.sam, passwordHash, invitedById: alex!.id })
    .returning();
  if (!alex || !sam) throw new Error('Failed to insert sample accounts');
  const owners = { alex, sam };

  for (const user of [alex, sam]) {
    await ctx.db.insert(storagePolicies).values([
      { ownerId: user.id, mediaType: 'image', mode: 'original' },
      { ownerId: user.id, mediaType: 'video', mode: 'original' },
    ]);
  }

  const personIds = new Map<string, string>();
  const faceCounts = new Map<string, { count: number; coverId: string | null }>();
  for (const person of SAMPLE_PEOPLE) {
    const [row] = await ctx.db
      .insert(people)
      .values({ ownerId: owners[person.owner].id, name: person.name })
      .returning({ id: people.id });
    personIds.set(person.key, row!.id);
    faceCounts.set(person.key, { count: 0, coverId: null });
  }

  const rendered = new Map<string, RenderedShot>();
  const assetIds = new Map<string, string>();
  let faceVariant = 0;
  for (const shot of SAMPLE_SHOTS) {
    const photo = rendered.get(shot.id) ?? (await renderSamplePhoto(shot));
    rendered.set(shot.id, photo);
    const { file } = await ctx.files.ingest(photo.bytes, { mimeType: 'image/jpeg' });
    for (const ownerKey of shot.owners) {
      const owner = owners[ownerKey];
      const [asset] = await ctx.db
        .insert(assets)
        .values({
          ownerId: owner.id,
          fileId: file.id,
          type: 'image',
          checksumSha1: file.sha1,
          originalFilename: shot.filename,
          mimeType: 'image/jpeg',
          capturedAt: photo.capturedAt,
          capturedLocal: sql`${photo.wallClock}::timestamp`,
          timezone: shot.timeZone,
          localDate: photo.localDate,
          latitude: shot.place?.latitude ?? null,
          longitude: shot.place?.longitude ?? null,
          city: shot.place?.city ?? null,
          region: shot.place?.region ?? null,
          country: shot.place?.country ?? null,
          countryCode: shot.place?.countryCode ?? null,
          cameraMake: 'NGP',
          cameraModel: 'Seed',
          width: photo.width,
          height: photo.height,
          isFavorite: shot.favorite ?? false,
          processingState: 'pending',
        })
        .returning({ id: assets.id });
      assetIds.set(`${shot.id}:${ownerKey}`, asset!.id);

      for (const face of photo.faces.filter((item) => item.owner === ownerKey)) {
        const personId = personIds.get(face.personKey);
        if (!personId) throw new Error(`Unknown sample person ${face.personKey}`);
        const [row] = await ctx.db
          .insert(faces)
          .values({
            assetId: asset!.id,
            ownerId: owner.id,
            personId,
            boxX: face.boxX,
            boxY: face.boxY,
            boxWidth: face.boxWidth,
            boxHeight: face.boxHeight,
            landmarks: face.landmarks,
            detectionScore: 0.98,
            quality: 0.9,
            embedding: faceEmbedding(face.personKey, faceVariant),
            model: 'seed',
            assignedManually: true,
          })
          .returning({ id: faces.id });
        faceVariant += 1;
        const stats = faceCounts.get(face.personKey)!;
        stats.count += 1;
        stats.coverId ??= row!.id;
      }
    }
  }

  for (const [key, stats] of faceCounts) {
    await ctx.db
      .update(people)
      .set({ faceCount: stats.count, coverFaceId: stats.coverId })
      .where(eq(people.id, personIds.get(key)!));
  }

  const coverId = assetIds.get('port-2024:alex');
  const [album] = await ctx.db
    .insert(albums)
    .values({
      ownerId: alex.id,
      title: SAMPLE_ALBUM.title,
      description: SAMPLE_ALBUM.description,
      coverAssetId: coverId,
      isLive: false,
    })
    .returning({ id: albums.id });
  await ctx.db.insert(albumMembers).values({
    albumId: album!.id,
    userId: sam.id,
    role: 'contributor',
    showInTimeline: true,
    invitedById: alex.id,
    acceptedAt: new Date(),
  });
  const shared = [...assetIds.entries()].flatMap(([key, assetId]) => {
    const splitAt = key.lastIndexOf(':');
    const shot = SAMPLE_SHOTS.find((item) => item.id === key.slice(0, splitAt));
    if (!shot?.shared || !album) return [];
    const ownerKey = key.slice(splitAt + 1) === 'sam' ? 'sam' : 'alex';
    return [
      {
        albumId: album.id,
        assetId,
        addedById: owners[ownerKey].id,
        source: 'manual' as const,
      },
    ];
  });
  if (shared.length > 0) await ctx.db.insert(albumAssets).values(shared);

  await ctx.db.update(serverConfig).set({ name: 'Home Photos' }).where(eq(serverConfig.id, 1));

  console.log('');
  console.log('Sample library is ready.');
  console.log(`  Alex (admin)   ${SAMPLE_ACCOUNTS.alex.email}`);
  console.log(`  Sam (member)   ${SAMPLE_ACCOUNTS.sam.email}`);
  console.log(`  Password       ${SAMPLE_PASSWORD}`);
  console.log(`  Album          ${SAMPLE_ALBUM.title} (Sam can see it)`);
  console.log(`  Photos         ${SAMPLE_SHOTS.length} files, ${assetIds.size} assets`);
  console.log(`  Library        ${ctx.env.LIBRARY_DIR}`);
} catch (error) {
  log.error({ err: error }, 'Seed failed');
  process.exitCode = 1;
} finally {
  await ctx.pool.end();
}
