import { readFile } from 'node:fs/promises';
import { CLIP_EMBEDDING_DIMENSIONS, FACE_EMBEDDING_DIMENSIONS } from '@ngp/shared';
import { and, eq, inArray } from 'drizzle-orm';
import type { AppContext } from '../context';
import {
  assetEmbeddings,
  assetFiles,
  assetTags,
  assets,
  faces,
  files,
  people,
  tags,
} from '../db/schema';
import { syncAlbumRulesForAsset } from '../albums/rules';
import { MlRejected } from '../ml/client';
import { refreshPeople } from '../people/library';
import { LocalStorageProvider } from '../storage/local';
import {
  choosePerson,
  cosineDistance,
  intersectionOverUnion,
  normalizeBox,
  normalizePoint,
  parseVector,
  tagProbability,
  type KnownFace,
  type NormBox,
} from './scoring';
import { SCENE_TAGS } from './vocabulary';

/** A new detection this close to a hand-corrected face is the same face, so leave the correction. */
const MANUAL_OVERLAP = 0.4;

/**
 * Detects faces, groups them into people, and tags the photo.
 * Safe to run again: automatic faces and clip tags are replaced; a face someone
 * corrected by hand is left alone.
 *
 * Throws {@link MlUnavailable} when the recognition service cannot run yet so the
 * job queue retries. A rejected image is recorded and not retried.
 */
export async function recognizeAsset(ctx: AppContext, assetId: string): Promise<void> {
  if (!ctx.env.ML_URL) return;

  const [asset] = await ctx.db.select().from(assets).where(eq(assets.id, assetId));
  if (!asset || asset.trashedAt || asset.processingState !== 'ready') return;

  const image = await analysisImage(ctx, asset.id, asset.type, asset.fileId, asset.mimeType);
  if (!image) {
    await setSteps(ctx, assetId, { faces: 'skipped', tags: 'skipped' });
    return;
  }

  let analysis;
  try {
    analysis = await ctx.ml.analyze(image.bytes, image.mimeType);
  } catch (error) {
    if (error instanceof MlRejected) {
      ctx.log.warn({ assetId, err: error }, 'Recognition rejected this photo');
      await setSteps(ctx, assetId, { faces: 'failed', tags: 'failed' });
      return;
    }
    throw error;
  }

  const advice = await ctx.ml.advice();
  const labelEmbeddings = analysis.clipEmbedding
    ? await ctx.ml.tagEmbeddings(SCENE_TAGS.map((tag) => tag.label))
    : [];

  const detected = analysis.faces.map((face) => ({
    box: normalizeBox(
      face.box.x1,
      face.box.y1,
      face.box.x2,
      face.box.y2,
      analysis.width,
      analysis.height,
    ),
    landmarks: face.landmarks.map(([x, y]) =>
      normalizePoint(x, y, analysis.width, analysis.height),
    ),
    score: face.score,
    quality: face.quality,
    embedding:
      face.embedding && face.embedding.length === FACE_EMBEDDING_DIMENSIONS ? face.embedding : null,
  }));
  detected.sort((left, right) => right.quality - left.quality);

  const clip =
    analysis.clipEmbedding && analysis.clipEmbedding.length === CLIP_EMBEDDING_DIMENSIONS
      ? { model: analysis.clipModel ?? 'clip', embedding: analysis.clipEmbedding }
      : null;

  const scoredTags = clip
    ? SCENE_TAGS.flatMap((tag, index) => {
        const labelEmbedding = labelEmbeddings[index];
        if (!labelEmbedding || labelEmbedding.length !== clip.embedding.length) return [];
        const cosine = 1 - cosineDistance(clip.embedding, labelEmbedding);
        const confidence = tagProbability(cosine, advice.logitScale, advice.logitBias);
        if (confidence < advice.tagMinProbability) return [];
        return [{ slug: tag.slug, name: tag.name, label: tag.label, confidence }];
      })
    : [];

  const touchedPeople = await ctx.db.transaction(async (tx) => {
    const manual = await tx
      .select({
        boxX: faces.boxX,
        boxY: faces.boxY,
        boxWidth: faces.boxWidth,
        boxHeight: faces.boxHeight,
      })
      .from(faces)
      .where(and(eq(faces.assetId, asset.id), eq(faces.assignedManually, true)));
    const manualBoxes: NormBox[] = manual.map((row) => ({
      x: row.boxX,
      y: row.boxY,
      width: row.boxWidth,
      height: row.boxHeight,
    }));

    const previous = await tx
      .select({ personId: faces.personId, embedding: faces.embedding })
      .from(faces)
      .where(and(eq(faces.ownerId, asset.ownerId), eq(faces.ignored, false)));
    const known: KnownFace[] = [];
    for (const row of previous) {
      if (!row.personId) continue;
      const embedding = parseVector(row.embedding);
      if (!embedding) continue;
      known.push({ personId: row.personId, embedding });
    }

    const removed = await tx
      .delete(faces)
      .where(and(eq(faces.assetId, asset.id), eq(faces.assignedManually, false)))
      .returning({ personId: faces.personId });
    const touched = new Set(removed.flatMap((row) => (row.personId ? [row.personId] : [])));

    for (const face of detected) {
      if (manualBoxes.some((box) => intersectionOverUnion(box, face.box) >= MANUAL_OVERLAP))
        continue;
      const assignment = choosePerson({
        embedding: face.embedding,
        quality: face.quality,
        known,
        rejectedPersonIds: new Set(),
        thresholds: {
          matchMaxDistance: advice.matchMaxDistance,
          seedMinQuality: advice.seedMinQuality,
        },
      });
      let personId: string | null = null;
      if (assignment.kind === 'existing') personId = assignment.personId;
      if (assignment.kind === 'create') {
        const [created] = await tx
          .insert(people)
          .values({ ownerId: asset.ownerId })
          .returning({ id: people.id });
        personId = created?.id ?? null;
      }
      if (personId && face.embedding) known.push({ personId, embedding: face.embedding });
      if (personId) touched.add(personId);
      await tx.insert(faces).values({
        assetId: asset.id,
        ownerId: asset.ownerId,
        personId,
        boxX: face.box.x,
        boxY: face.box.y,
        boxWidth: face.box.width,
        boxHeight: face.box.height,
        landmarks: face.landmarks,
        detectionScore: face.score,
        quality: face.quality,
        embedding: face.embedding,
        model: analysis.model,
      });
    }

    if (clip) {
      await tx
        .insert(tags)
        .values(SCENE_TAGS.map((tag) => ({ slug: tag.slug, name: tag.name, prompt: tag.label })))
        .onConflictDoNothing({ target: tags.slug });
      const vocabulary = await tx
        .select({ id: tags.id, slug: tags.slug })
        .from(tags)
        .where(
          inArray(
            tags.slug,
            SCENE_TAGS.map((tag) => tag.slug),
          ),
        );
      const tagId = new Map(vocabulary.map((tag) => [tag.slug, tag.id]));
      await tx
        .delete(assetTags)
        .where(and(eq(assetTags.assetId, asset.id), eq(assetTags.source, 'clip')));
      const rows = scoredTags.flatMap((tag) => {
        const id = tagId.get(tag.slug);
        if (!id) return [];
        return [
          {
            assetId: asset.id,
            tagId: id,
            confidence: Math.min(1, Math.max(0, tag.confidence)),
            source: 'clip' as const,
          },
        ];
      });
      if (rows.length > 0) await tx.insert(assetTags).values(rows).onConflictDoNothing();
      await tx
        .insert(assetEmbeddings)
        .values({ assetId: asset.id, model: clip.model, embedding: clip.embedding })
        .onConflictDoUpdate({
          target: assetEmbeddings.assetId,
          set: { model: clip.model, embedding: clip.embedding },
        });
    }

    const [current] = await tx
      .select({ steps: assets.processingSteps })
      .from(assets)
      .where(eq(assets.id, asset.id));
    await tx
      .update(assets)
      .set({
        processingSteps: {
          ...(current?.steps ?? {}),
          faces: 'done',
          tags: clip ? 'done' : 'skipped',
        },
      })
      .where(eq(assets.id, asset.id));

    await refreshPeople(tx, [...touched]);
    return touched.size;
  });

  await syncAlbumRulesForAsset(ctx.db, assetId);

  ctx.log.debug(
    {
      assetId,
      faces: detected.length,
      tags: scoredTags.map((tag) => tag.slug),
      people: touchedPeople,
    },
    'Recognized photo',
  );
}

/** Queues recognition, or runs it now when the queue is off. Does nothing until ML_URL is set. */
export async function scheduleRecognition(ctx: AppContext, assetId: string): Promise<void> {
  if (!ctx.env.ML_URL) return;
  if (ctx.jobs?.isRunning()) {
    await ctx.jobs.enqueueRecognition(assetId);
    return;
  }
  await recognizeAsset(ctx, assetId);
}

async function analysisImage(
  ctx: AppContext,
  assetId: string,
  type: 'image' | 'video',
  fileId: string,
  mimeType: string | null,
): Promise<{ bytes: Buffer; mimeType: string } | null> {
  if (!(ctx.storage instanceof LocalStorageProvider)) return null;
  const [preview] = await ctx.db
    .select({ storageKey: files.storageKey, mimeType: assetFiles.mimeType })
    .from(assetFiles)
    .innerJoin(files, eq(files.id, assetFiles.fileId))
    .where(and(eq(assetFiles.assetId, assetId), eq(assetFiles.kind, 'preview')));
  if (preview) {
    return {
      bytes: await readFile(ctx.storage.localPath(preview.storageKey)),
      mimeType: preview.mimeType ?? 'image/webp',
    };
  }
  if (type !== 'image') return null;
  const file = await ctx.files.get(fileId);
  if (!file || file.sizeBytes > 40 * 1024 * 1024) return null;
  const mime = file.mimeType ?? mimeType ?? 'application/octet-stream';
  if (!mime.startsWith('image/')) return null;
  return { bytes: await readFile(ctx.storage.localPath(file.storageKey)), mimeType: mime };
}

async function setSteps(
  ctx: AppContext,
  assetId: string,
  patch: Record<string, string>,
): Promise<void> {
  const [row] = await ctx.db
    .select({ steps: assets.processingSteps })
    .from(assets)
    .where(eq(assets.id, assetId));
  if (!row) return;
  await ctx.db
    .update(assets)
    .set({ processingSteps: { ...row.steps, ...patch } })
    .where(eq(assets.id, assetId));
}
