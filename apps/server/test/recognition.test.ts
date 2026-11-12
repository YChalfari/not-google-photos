import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assetTags, assets, tags } from '../src/db/schema';
import { recognizeAsset } from '../src/recognition/recognize';
import { choosePerson, cosineDistance, tagProbability } from '../src/recognition/scoring';
import { slugsInText, splitQuery } from '../src/search/text';
import { createUser, insertAsset, insertDerivedFile, signIn } from './support/factories';
import { createTestServer, type TestServer } from './support/server';

function unit(index: number, dimensions: number): number[] {
  const values = Array.from({ length: dimensions }, () => 0);
  values[index] = 1;
  return values;
}

const LABELS = ['birthday', 'party', 'cake', 'cat', 'dog'];

describe('how a face becomes a person', () => {
  const thresholds = { matchMaxDistance: 0.5, seedMinQuality: 0.5 };
  const known = [{ personId: 'person-1', embedding: unit(0, 8) }];

  it('joins a close face and only lets a clear face start someone new', () => {
    expect(cosineDistance(unit(0, 8), unit(0, 8))).toBeCloseTo(0);
    expect(cosineDistance(unit(0, 8), unit(1, 8))).toBeCloseTo(1);
    expect(
      choosePerson({
        embedding: unit(0, 8),
        quality: 0.2,
        known,
        rejectedPersonIds: new Set(),
        thresholds,
      }),
    ).toEqual({ kind: 'existing', personId: 'person-1' });
    expect(
      choosePerson({
        embedding: unit(1, 8),
        quality: 0.9,
        known,
        rejectedPersonIds: new Set(),
        thresholds,
      }),
    ).toEqual({ kind: 'create' });
    expect(
      choosePerson({
        embedding: unit(1, 8),
        quality: 0.2,
        known,
        rejectedPersonIds: new Set(),
        thresholds,
      }),
    ).toEqual({ kind: 'none' });
    expect(
      choosePerson({
        embedding: unit(0, 8),
        quality: 0.9,
        known,
        rejectedPersonIds: new Set(['person-1']),
        thresholds,
      }),
    ).toEqual({ kind: 'create' });
  });

  it('keeps a tag when its probability clears the cut-off', () => {
    expect(tagProbability(1, 100, -10)).toBeGreaterThan(0.005);
    expect(tagProbability(0, 100, -10)).toBeLessThan(0.005);
  });

  it('reads years and plurals out of a search', () => {
    expect(splitQuery('cake 2024')).toEqual({ text: 'cake', year: 2024 });
    expect(slugsInText('cats and dogs')).toEqual(['cat', 'and', 'dog']);
  });
});

describe('recognition on a library', () => {
  let ml: Server;
  let mlUrl = '';
  let t: TestServer;

  beforeAll(async () => {
    ml = createServer((request, response) => {
      void handleMl(request, response);
    });
    await new Promise<void>((resolve) => ml.listen(0, '127.0.0.1', resolve));
    const address = ml.address();
    if (!address || typeof address === 'string') throw new Error('mock ML did not bind');
    mlUrl = `http://127.0.0.1:${address.port}`;
    t = await createTestServer({ env: { ML_URL: mlUrl } });
  }, 30_000);

  afterAll(async () => {
    await t?.close();
    await new Promise<void>((resolve, reject) => ml.close((error) => (error ? reject(error) : resolve())));
  });

  it('groups matching faces, tags cake, and finds cats by the plural', async () => {
    const user = await createUser(t.ctx, { email: 'people@example.com' });
    const client = await signIn(t.app, user.email);
    const markers = [1, 1, 2, 3];
    const created = [];
    for (const marker of markers) {
      const asset = await insertAsset(t.ctx, user.id, { filename: `shot-${marker}.jpg` });
      await insertDerivedFile(t.ctx, asset.id, 'preview', Buffer.from([marker, 9, 9, 9]));
      await t.ctx.db
        .update(assets)
        .set({ processingState: 'ready', processingSteps: { thumbnails: 'done', metadata: 'done' } })
        .where(eq(assets.id, asset.id));
      created.push(asset);
    }
    for (const asset of created) await recognizeAsset(t.ctx, asset.id);
    await recognizeAsset(t.ctx, created[0]!.id);

    const listed = await client.call('people.list');
    expect(listed.status).toBe(200);
    expect(listed.data.people.map((person) => person.faceCount).sort()).toEqual([1, 2]);

    const cakes = await client.call('search.query', { query: { tag: 'cake' } });
    expect(cakes.status).toBe(200);
    expect(cakes.data.items).toHaveLength(4);

    const group = listed.data.people.find((person) => person.faceCount === 2);
    expect(group).toBeTruthy();
    expect(group?.coverBox).toEqual({ x: 0.1, y: 0.1, width: 0.3, height: 0.5 });
    const named = await client.call('people.update', {
      params: { id: group!.id },
      body: { name: 'Maya' },
    });
    expect(named.status).toBe(200);
    const byName = await client.call('search.query', { query: { q: 'Maya' } });
    expect(byName.data.items).toHaveLength(2);

    const [cat] = await t.ctx.db.select().from(tags).where(eq(tags.slug, 'cat'));
    expect(cat).toBeTruthy();
    await t.ctx.db.insert(assetTags).values({
      assetId: created[3]!.id,
      tagId: cat!.id,
      confidence: 0.8,
      source: 'manual',
    });
    const cats = await client.call('search.query', { query: { q: 'cats' } });
    expect(cats.data.items.map((item) => item.id)).toEqual([created[3]!.id]);

    const detail = await client.call('assets.get', { params: { id: created[3]!.id } });
    expect(detail.data.faces).toHaveLength(1);
    expect(detail.data.faces[0]?.person).toBeNull();
    expect(detail.data.tags.map((tag) => tag.name)).toContain('Cake');

    const shared = await client.call('assets.get', { params: { id: created[0]!.id } });
    const face = shared.data.faces[0];
    expect(face?.person?.id).toBe(group!.id);
    const rejected = await client.call('faces.notThisPerson', {
      params: { id: face!.id },
      body: { personId: group!.id },
    });
    expect(rejected.status).toBe(204);
    await recognizeAsset(t.ctx, created[0]!.id);
    const after = await client.call('assets.get', { params: { id: created[0]!.id } });
    expect(after.data.faces[0]?.person).toBeNull();
    const remaining = await client.call('people.get', { params: { id: group!.id } });
    expect(remaining.data.person.faceCount).toBe(1);

    const looseId = after.data.faces[0]!.id;
    const started = await client.call('faces.update', {
      params: { id: looseId },
      body: { createPerson: true },
    });
    expect(started.status).toBe(200);
    expect(started.data.face.personId).toEqual(expect.any(String));
    expect(started.data.face.personId).not.toBe(group!.id);
    const newborn = await client.call('people.get', { params: { id: started.data.face.personId! } });
    expect(newborn.data.person.faceCount).toBe(1);
    expect(newborn.data.person.name).toBeNull();
    const moved = await client.call('faces.update', {
      params: { id: looseId },
      body: { personId: group!.id },
    });
    expect(moved.status).toBe(200);
    expect(moved.data.face.personId).toBe(group!.id);
  }, 30_000);

  it('promotes a review photo only when the face is already in the library', async () => {
    const user = await createUser(t.ctx, { email: 'review-faces@example.com' });
    const client = await signIn(t.app, user.email);

    const library = await insertAsset(t.ctx, user.id, { filename: 'library.jpg' });
    await insertDerivedFile(t.ctx, library.id, 'preview', Buffer.from([1, 9, 9, 9]));
    await t.ctx.db
      .update(assets)
      .set({ processingState: 'ready', processingSteps: { thumbnails: 'done', metadata: 'done' } })
      .where(eq(assets.id, library.id));
    await recognizeAsset(t.ctx, library.id);

    const known = await insertAsset(t.ctx, user.id, { filename: 'known.jpg', intake: 'review' });
    await insertDerivedFile(t.ctx, known.id, 'preview', Buffer.from([1, 8, 8, 8]));
    await t.ctx.db
      .update(assets)
      .set({ processingState: 'ready', processingSteps: { thumbnails: 'done', metadata: 'done' } })
      .where(eq(assets.id, known.id));
    await recognizeAsset(t.ctx, known.id);
    const [promoted] = await t.ctx.db.select().from(assets).where(eq(assets.id, known.id));
    expect(promoted?.intake).toBe('library');

    const stranger = await insertAsset(t.ctx, user.id, { filename: 'stranger.jpg', intake: 'review' });
    await insertDerivedFile(t.ctx, stranger.id, 'preview', Buffer.from([2, 7, 7, 7]));
    await t.ctx.db
      .update(assets)
      .set({ processingState: 'ready', processingSteps: { thumbnails: 'done', metadata: 'done' } })
      .where(eq(assets.id, stranger.id));
    await recognizeAsset(t.ctx, stranger.id);
    const [waiting] = await t.ctx.db.select().from(assets).where(eq(assets.id, stranger.id));
    expect(waiting?.intake).toBe('review');
    expect(waiting?.processingSteps).toMatchObject({ faces: 'done', tags: 'skipped' });

    const people = await client.call('people.list');
    expect(people.data.people).toHaveLength(1);
    expect(people.data.people[0]?.faceCount).toBe(2);

    const month = await client.call('timeline.bucket', {
      params: { key: '2024-07' },
      query: { scope: 'library', withShared: 'false' },
    });
    expect(month.data.assets.map((asset) => asset.id).sort()).toEqual([known.id, library.id].sort());
    const review = await client.call('assets.review', { query: { limit: 20 } });
    expect(review.data.items.map((item) => item.id)).toEqual([stranger.id]);
  }, 30_000);
});

async function handleMl(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  const body = await readBody(request);
  const send = (payload: unknown) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(payload));
  };
  if (url.pathname === '/health') {
    send({ status: 'ok' });
    return;
  }
  if (url.pathname === '/v1/models') {
    send({
      faces: { recommended: { match_max_distance: 0.5, suggest_max_distance: 0.6, seed_min_quality: 0.5 } },
      clip: { logit_scale: 100, logit_bias: -10, recommended: { tag_min_probability: 0.005 } },
    });
    return;
  }
  if (url.pathname === '/v1/clip/text/batch') {
    const parsed = JSON.parse(body.toString()) as { texts?: string[] };
    send({
      embeddings: (parsed.texts ?? []).map((text) => unit(Math.max(0, LABELS.indexOf(text.toLowerCase())), 768)),
    });
    return;
  }
  if (url.pathname === '/v1/clip/text') {
    const parsed = JSON.parse(body.toString()) as { text?: string };
    const word = (parsed.text ?? '').toLowerCase();
    const label = word === 'cats' ? 'cat' : word === 'dogs' ? 'dog' : word;
    send({ embedding: unit(Math.max(0, LABELS.indexOf(label)), 768) });
    return;
  }
  if (url.pathname === '/v1/analyze') {
    const marker = body[0] ?? 1;
    const samePerson = marker === 1;
    const lowQuality = marker === 3;
    send({
      image: { width: 100, height: 80 },
      faces: {
        model: 'test-faces',
        faces: [
          {
            bbox: { x1: 10, y1: 8, x2: 40, y2: 48 },
            landmarks: [
              [16, 20],
              [32, 20],
              [24, 30],
              [18, 40],
              [30, 40],
            ],
            score: 0.99,
            quality: lowQuality ? 0.1 : 0.9,
            embedding: unit(samePerson ? 0 : lowQuality ? 4 : 1, 512),
          },
        ],
      },
      clip: { model: 'test-clip', embedding: unit(2, 768) },
    });
    return;
  }
  response.writeHead(404);
  response.end();
}

function readBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', reject);
  });
}
