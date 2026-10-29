import { CLIP_EMBEDDING_DIMENSIONS } from '@ngp/shared';
import { sql } from 'drizzle-orm';
import type { AppContext } from '../context';
import { vectorLiteral } from '../recognition/scoring';

/** Cosine distance cut-off for a free-text match. Similarity is 1 minus this. */
const MAX_DISTANCE = 0.82;

/**
 * Photos in this library whose stored image embedding is near the search text.
 * Empty when recognition is off, not ready, or nothing is close enough.
 */
export async function similarAssetIds(
  ctx: AppContext,
  userId: string,
  text: string,
  limit: number,
): Promise<string[]> {
  const embedding = await ctx.ml.embedText(text);
  if (!embedding || embedding.length !== CLIP_EMBEDDING_DIMENSIONS) return [];
  let literal: string;
  try {
    literal = vectorLiteral(embedding);
  } catch {
    return [];
  }
  const result = await ctx.db.execute(sql`
    select asset_embeddings.asset_id as id
    from asset_embeddings
    join assets on assets.id = asset_embeddings.asset_id
    where assets.owner_id = ${userId}
      and assets.trashed_at is null
      and (asset_embeddings.embedding <=> ${literal}::vector) <= ${MAX_DISTANCE}
    order by asset_embeddings.embedding <=> ${literal}::vector
    limit ${limit}
  `);
  const records = Array.isArray(result)
    ? result
    : result && typeof result === 'object' && 'rows' in result && Array.isArray(result.rows)
      ? result.rows
      : [];
  return records.flatMap((row) => {
    const id = (row as { id?: unknown }).id;
    return typeof id === 'string' ? [id] : [];
  });
}
