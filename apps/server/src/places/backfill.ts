import { and, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import { assets } from '../db/schema';
import { nearestPlace } from './geocode';

/**
 * Fills city, region, and country on photos that already have coordinates and no city.
 * A coordinate with no city inside the lookup radius is marked so it is not tried again.
 */
export async function fillMissingPlaces(
  db: Db,
  limit = 200,
): Promise<{ filled: number; scanned: number }> {
  const rows = await db
    .select({
      id: assets.id,
      latitude: assets.latitude,
      longitude: assets.longitude,
    })
    .from(assets)
    .where(
      and(
        isNotNull(assets.latitude),
        isNotNull(assets.longitude),
        isNull(assets.city),
        sql`coalesce(${assets.processingSteps}->>'places', '') <> 'none'`,
      ),
    )
    .limit(limit);

  let filled = 0;
  for (const row of rows) {
    if (row.latitude == null || row.longitude == null) continue;
    const place = nearestPlace(row.latitude, row.longitude);
    await db
      .update(assets)
      .set({
        ...(place
          ? {
              city: place.city,
              region: place.region,
              country: place.country,
              countryCode: place.countryCode,
            }
          : {}),
        processingSteps: sql`coalesce(${assets.processingSteps}, '{}'::jsonb) || ${JSON.stringify({
          places: place ? 'done' : 'none',
        })}::jsonb`,
      })
      .where(and(eq(assets.id, row.id), isNull(assets.city)));
    if (place) filled += 1;
  }
  return { filled, scanned: rows.length };
}

/** Works through the library in batches so startup can catch up without one huge transaction. */
export async function backfillPlaces(db: Db): Promise<number> {
  let total = 0;
  let scanned = 0;
  for (;;) {
    const batch = await fillMissingPlaces(db, 200);
    total += batch.filled;
    scanned += batch.scanned;
    if (batch.scanned < 200 || scanned >= 20_000) break;
  }
  return total;
}
