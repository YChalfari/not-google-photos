import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import type { AppContext } from '../context';
import type { DbOrTx } from '../db/client';
import { assets, memories, memoryAssets, users, type MemoryRow } from '../db/schema';

const MEMORY_CAP = 40;

export interface DatedAsset {
  id: string;
  year: number;
}

/** One photo from each year, newest year first, until the cap. */
export function spreadAcrossYears(rows: readonly DatedAsset[], cap = MEMORY_CAP): DatedAsset[] {
  const byYear = new Map<number, DatedAsset[]>();
  for (const row of rows) {
    const list = byYear.get(row.year);
    if (list) list.push(row);
    else byYear.set(row.year, [row]);
  }
  const years = [...byYear.keys()].sort((left, right) => right - left);
  const picked: DatedAsset[] = [];
  let index = 0;
  while (picked.length < cap) {
    let added = false;
    for (const year of years) {
      const item = byYear.get(year)?.[index];
      if (!item) continue;
      picked.push(item);
      added = true;
      if (picked.length >= cap) break;
    }
    if (!added) break;
    index += 1;
  }
  return picked;
}

export function memorySubtitle(years: readonly number[], memoryYear: number): string | null {
  const sorted = [...new Set(years)].sort((left, right) => left - right);
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  if (first === undefined || last === undefined) return null;
  if (first === last) {
    const ago = memoryYear - first;
    if (ago === 1) return '1 year ago';
    if (ago > 1) return `${ago} years ago`;
    return String(first);
  }
  return `${first} – ${last}`;
}

/** Calendar date in the server's local timezone, `YYYY-MM-DD`. */
export function calendarDate(now = new Date()): string {
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${month}-${day}`;
}

export function addDays(date: string, days: number): string {
  const [year, month, day] = date.split('-').map(Number);
  const utc = new Date(Date.UTC(year ?? 1970, (month ?? 1) - 1, day ?? 1));
  utc.setUTCDate(utc.getUTCDate() + days);
  return utc.toISOString().slice(0, 10);
}

export function eachDate(from: string, to: string, cap = 31): string[] {
  if (from > to) return [];
  const dates: string[] = [];
  let cursor = from;
  while (cursor <= to && dates.length < cap) {
    dates.push(cursor);
    cursor = addDays(cursor, 1);
  }
  return dates;
}

async function candidates(db: DbOrTx, userId: string, date: string): Promise<DatedAsset[]> {
  const rows = await db
    .select({ id: assets.id, localDate: assets.localDate })
    .from(assets)
    .where(
      and(
        eq(assets.ownerId, userId),
        eq(assets.intake, 'library'),
        isNull(assets.trashedAt),
        sql`${assets.localDate} is not null`,
        sql`to_char(${assets.localDate}, 'MM-DD') = ${date.slice(5)}`,
        sql`${assets.localDate} < cast(${date} as date)`,
        sql`not exists (
          select 1 from faces
          inner join people on people.id = faces.person_id
          where faces.asset_id = ${assets.id}
            and faces.ignored = false
            and people.hide_from_memories
        )`,
      ),
    )
    .orderBy(desc(assets.localDate), desc(assets.capturedAt), desc(assets.id));
  return rows.flatMap((row) => {
    if (!row.localDate) return [];
    return [{ id: row.id, year: Number(row.localDate.slice(0, 4)) }];
  });
}

/**
 * One on-this-day memory for this person and date. A second call returns the same row,
 * including one that was dismissed.
 */
export async function ensureOnThisDay(
  ctx: AppContext,
  userId: string,
  date: string,
): Promise<MemoryRow | null> {
  return ctx.db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${userId}), hashtext(${`on_this_day:${date}`}))`,
    );
    const [existing] = await tx
      .select()
      .from(memories)
      .where(
        and(
          eq(memories.ownerId, userId),
          eq(memories.kind, 'on_this_day'),
          eq(memories.memoryDate, date),
        ),
      )
      .limit(1);
    if (existing) return existing;
    const picked = spreadAcrossYears(await candidates(tx, userId, date));
    if (picked.length === 0) return null;
    const [created] = await tx
      .insert(memories)
      .values({
        ownerId: userId,
        kind: 'on_this_day',
        memoryDate: date,
        title: 'On this day',
        subtitle: memorySubtitle(
          picked.map((item) => item.year),
          Number(date.slice(0, 4)),
        ),
        coverAssetId: picked[0]!.id,
      })
      .returning();
    await tx.insert(memoryAssets).values(
      picked.map((item, position) => ({
        memoryId: created!.id,
        assetId: item.id,
        position,
      })),
    );
    return created!;
  });
}

export async function ensureMemories(ctx: AppContext, userId: string, from: string, to: string) {
  for (const date of eachDate(from, to)) await ensureOnThisDay(ctx, userId, date);
}

/** Builds today's memory for every active account. Safe to run more than once. */
export async function buildTodaysMemories(ctx: AppContext, today = calendarDate()) {
  const accounts = await ctx.db
    .select({ id: users.id })
    .from(users)
    .where(isNull(users.disabledAt));
  let built = 0;
  for (const account of accounts) {
    const memory = await ensureOnThisDay(ctx, account.id, today);
    if (memory && memory.dismissedAt == null) built += 1;
  }
  return { date: today, built };
}
