import { parseVector } from '../recognition/scoring';

export type MlStatus = 'ok' | 'unreachable' | 'disabled';

/** The recognition service is down, still loading, or not configured. Callers retry. */
export class MlUnavailable extends Error {
  constructor(message = 'Recognition is not ready') {
    super(message);
    this.name = 'MlUnavailable';
  }
}

/** The image itself was rejected. Retrying the same bytes will not help. */
export class MlRejected extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MlRejected';
  }
}

export interface MlFace {
  box: { x1: number; y1: number; x2: number; y2: number };
  landmarks: [number, number][];
  score: number;
  quality: number;
  embedding: number[] | null;
}

export interface MlAnalysis {
  width: number;
  height: number;
  model: string | null;
  faces: MlFace[];
  clipModel: string | null;
  clipEmbedding: number[] | null;
}

export interface MlAdvice {
  matchMaxDistance: number;
  seedMinQuality: number;
  logitScale: number;
  logitBias: number;
  tagMinProbability: number;
}

const FALLBACK_ADVICE: MlAdvice = {
  matchMaxDistance: 0.5,
  seedMinQuality: 0.5,
  logitScale: Math.exp(4.709494113922119),
  logitBias: -12.885268211364746,
  tagMinProbability: 0.005,
};

/** Talks to the Python ML service (`apps/ml`). Optional: the server runs fine without it. */
export class MlClient {
  private cached: { at: number; status: MlStatus } | undefined;
  private advicePromise: Promise<MlAdvice> | undefined;
  private tagKey = '';
  private tagPromise: Promise<number[][]> | undefined;

  constructor(readonly baseUrl: string | undefined) {}

  async status(): Promise<MlStatus> {
    if (!this.baseUrl) return 'disabled';
    if (this.cached && Date.now() - this.cached.at < 15_000) return this.cached.status;
    const status: MlStatus = await fetch(`${this.baseUrl}/health`, {
      signal: AbortSignal.timeout(1500),
    }).then(
      (response) => (response.ok ? 'ok' : 'unreachable'),
      () => 'unreachable',
    );
    this.cached = { at: Date.now(), status };
    return status;
  }

  /** Faces plus the image embedding. Throws when the service cannot run yet. */
  async analyze(bytes: Buffer, mimeType: string): Promise<MlAnalysis> {
    const response = await this.request(
      '/v1/analyze',
      {
        method: 'POST',
        headers: { 'content-type': mimeType },
        body: new Uint8Array(bytes),
      },
      120_000,
    );
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 300);
      throw new MlRejected(detail || `Recognition rejected the image (${response.status})`);
    }
    return parseAnalysis(await readJson(response));
  }

  /** Clustering and tag cut-offs published by the loaded models. */
  advice(): Promise<MlAdvice> {
    this.advicePromise ??= this.loadAdvice().catch((error: unknown) => {
      this.advicePromise = undefined;
      throw error;
    });
    return this.advicePromise;
  }

  /** One embedding per label, in the same order, using the model's tag prompt. */
  tagEmbeddings(labels: readonly string[]): Promise<number[][]> {
    const key = labels.join('\n');
    if (this.tagKey !== key) {
      this.tagKey = key;
      this.tagPromise = undefined;
    }
    this.tagPromise ??= this.loadTagEmbeddings(labels).catch((error: unknown) => {
      this.tagPromise = undefined;
      throw error;
    });
    return this.tagPromise;
  }

  /** Search-box text. Returns null when recognition is off or not ready. */
  async embedText(text: string): Promise<number[] | null> {
    if (!this.baseUrl || text.trim().length === 0) return null;
    try {
      const response = await this.request(
        '/v1/clip/text',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text, prompt: 'none' }),
        },
        30_000,
      );
      if (!response.ok) return null;
      const body = await readJson(response);
      return parseVector(body.embedding);
    } catch {
      return null;
    }
  }

  private async loadAdvice(): Promise<MlAdvice> {
    const response = await this.request('/v1/models', { method: 'GET' }, 15_000);
    if (!response.ok) return FALLBACK_ADVICE;
    const body = await readJson(response);
    const faces = asRecord(asRecord(body.faces).recommended);
    const clip = asRecord(body.clip);
    const clipRecommended = asRecord(clip.recommended);
    return {
      matchMaxDistance: numberOr(faces.match_max_distance, FALLBACK_ADVICE.matchMaxDistance),
      seedMinQuality: numberOr(faces.seed_min_quality, FALLBACK_ADVICE.seedMinQuality),
      logitScale: numberOr(clip.logit_scale, FALLBACK_ADVICE.logitScale),
      logitBias: numberOr(clip.logit_bias, FALLBACK_ADVICE.logitBias),
      tagMinProbability: numberOr(clipRecommended.tag_min_probability, FALLBACK_ADVICE.tagMinProbability),
    };
  }

  private async loadTagEmbeddings(labels: readonly string[]): Promise<number[][]> {
    const response = await this.request(
      '/v1/clip/text/batch',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ texts: labels, prompt: 'tag' }),
      },
      120_000,
    );
    if (!response.ok) {
      throw new MlUnavailable(`Tag embeddings failed (${response.status})`);
    }
    const body = await readJson(response);
    const embeddings = Array.isArray(body.embeddings) ? body.embeddings : [];
    return embeddings.map((item) => parseVector(item) ?? []);
  }

  private async request(path: string, init: RequestInit, timeoutMs: number): Promise<Response> {
    if (!this.baseUrl) throw new MlUnavailable('Recognition is not configured');
    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (response.status === 503 || response.status === 429) {
        throw new MlUnavailable(`Recognition is not ready (${response.status})`);
      }
      return response;
    } catch (error) {
      if (error instanceof MlUnavailable || error instanceof MlRejected) throw error;
      throw new MlUnavailable(error instanceof Error ? error.message : 'Recognition is not ready');
    }
  }
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  try {
    return asRecord(await response.json());
  } catch {
    throw new MlUnavailable('Recognition returned something that was not JSON');
  }
}

function parseAnalysis(body: Record<string, unknown>): MlAnalysis {
  const image = asRecord(body.image);
  const facesBody = asRecord(body.faces);
  const clip = asRecord(body.clip);
  const rawFaces = Array.isArray(facesBody.faces) ? facesBody.faces : [];
  return {
    width: numberOr(image.width, 0),
    height: numberOr(image.height, 0),
    model: typeof facesBody.model === 'string' ? facesBody.model : null,
    faces: rawFaces.map(parseFace),
    clipModel: typeof clip.model === 'string' ? clip.model : null,
    clipEmbedding: parseVector(clip.embedding),
  };
}

function parseFace(value: unknown): MlFace {
  const face = asRecord(value);
  const box = asRecord(face.bbox);
  const landmarks = Array.isArray(face.landmarks)
    ? face.landmarks.flatMap((point) => {
        const pair = asPoint(point);
        return pair ? [pair] : [];
      })
    : [];
  return {
    box: {
      x1: numberOr(box.x1, 0),
      y1: numberOr(box.y1, 0),
      x2: numberOr(box.x2, 0),
      y2: numberOr(box.y2, 0),
    },
    landmarks,
    score: numberOr(face.score, 0),
    quality: numberOr(face.quality, 0),
    embedding: parseVector(face.embedding),
  };
}

function asPoint(value: unknown): [number, number] | null {
  if (!Array.isArray(value) || value.length < 2) return null;
  const x = Number(value[0]);
  const y = Number(value[1]);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return [x, y];
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function numberOr(value: unknown, fallback: number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}
