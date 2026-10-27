import { TAG_ALIASES } from '../recognition/vocabulary';

const YEAR = /\b(?:19|20)\d{2}\b/;

/** Pulls a calendar year out of a search box so "cake 2024" can filter both. */
export function splitQuery(q: string): { text: string; year: number | null } {
  const match = YEAR.exec(q);
  const year = match ? Number(match[0]) : null;
  const text = q.replace(YEAR, ' ').replace(/\s+/g, ' ').trim();
  return { text, year };
}

/** Words in a query that might be tag slugs, with plurals folded (cats → cat). */
export function slugsInText(text: string): string[] {
  const slugs = new Set<string>();
  for (const word of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (word.length < 2) continue;
    slugs.add(TAG_ALIASES[word] ?? word);
  }
  return [...slugs];
}
