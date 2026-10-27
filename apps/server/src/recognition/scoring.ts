export interface KnownFace {
  personId: string;
  embedding: number[];
}

export interface ClusterThresholds {
  /** Join this person when cosine distance is at most this far. */
  matchMaxDistance: number;
  /** Only a clear face may start a person nobody has been matched to. */
  seedMinQuality: number;
}

export type Assignment =
  | { kind: 'existing'; personId: string }
  | { kind: 'create' }
  | { kind: 'none' };

export interface NormBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function cosineDistance(left: readonly number[], right: readonly number[]): number {
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const a = left[index] ?? 0;
    const b = right[index] ?? 0;
    dot += a * b;
    leftNorm += a * a;
    rightNorm += b * b;
  }
  if (leftNorm === 0 || rightNorm === 0) return 1;
  const similarity = dot / Math.sqrt(leftNorm * rightNorm);
  return 1 - Math.min(1, Math.max(-1, similarity));
}

/**
 * Nearest person within the match distance wins. A face the owner rejected is skipped.
 * Otherwise a clear face starts a new person, and a blurry one stays unassigned.
 */
export function choosePerson(input: {
  embedding: number[] | null;
  quality: number | null;
  known: readonly KnownFace[];
  rejectedPersonIds: ReadonlySet<string>;
  thresholds: ClusterThresholds;
}): Assignment {
  const embedding = input.embedding;
  if (!embedding || embedding.length === 0) return { kind: 'none' };

  let best: { personId: string; distance: number } | undefined;
  for (const row of input.known) {
    if (input.rejectedPersonIds.has(row.personId)) continue;
    if (row.embedding.length !== embedding.length) continue;
    const distance = cosineDistance(embedding, row.embedding);
    if (!best || distance < best.distance) best = { personId: row.personId, distance };
  }
  if (best && best.distance <= input.thresholds.matchMaxDistance) {
    return { kind: 'existing', personId: best.personId };
  }
  if ((input.quality ?? 0) >= input.thresholds.seedMinQuality) return { kind: 'create' };
  return { kind: 'none' };
}

/** sigmoid(scale * cosine + bias), with the tails clamped so Math.exp stays finite. */
export function tagProbability(cosine: number, scale: number, bias: number): number {
  const logit = scale * cosine + bias;
  if (logit >= 40) return 1;
  if (logit <= -40) return 0;
  return 1 / (1 + Math.exp(-logit));
}

export function parseVector(value: unknown): number[] | null {
  if (Array.isArray(value)) {
    const nums = value.map((item) => Number(item));
    return nums.length > 0 && nums.every((item) => Number.isFinite(item)) ? nums : null;
  }
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().replace(/^\[/, '').replace(/\]$/, '');
  if (!trimmed) return null;
  const nums = trimmed.split(',').map((part) => Number(part.trim()));
  return nums.length > 0 && nums.every((item) => Number.isFinite(item)) ? nums : null;
}

export function vectorLiteral(values: readonly number[]): string {
  if (values.length === 0 || values.some((value) => !Number.isFinite(value))) {
    throw new Error('Invalid embedding');
  }
  return `[${values.join(',')}]`;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/** Pixel box on the upright image, normalized to 0..1 from the top left. */
export function normalizeBox(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  imageWidth: number,
  imageHeight: number,
): NormBox {
  const width = imageWidth > 0 ? imageWidth : 1;
  const height = imageHeight > 0 ? imageHeight : 1;
  const left = clamp01(Math.min(x1, x2) / width);
  const top = clamp01(Math.min(y1, y2) / height);
  const right = clamp01(Math.max(x1, x2) / width);
  const bottom = clamp01(Math.max(y1, y2) / height);
  return { x: left, y: top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
}

export function normalizePoint(
  x: number,
  y: number,
  imageWidth: number,
  imageHeight: number,
): [number, number] {
  const width = imageWidth > 0 ? imageWidth : 1;
  const height = imageHeight > 0 ? imageHeight : 1;
  return [clamp01(x / width), clamp01(y / height)];
}

export function intersectionOverUnion(left: NormBox, right: NormBox): number {
  const overlapWidth = Math.max(
    0,
    Math.min(left.x + left.width, right.x + right.width) - Math.max(left.x, right.x),
  );
  const overlapHeight = Math.max(
    0,
    Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y),
  );
  const overlap = overlapWidth * overlapHeight;
  const union = left.width * left.height + right.width * right.height - overlap;
  return union <= 0 ? 0 : overlap / union;
}
