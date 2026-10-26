import { z } from 'zod';
import { defineEndpoints } from '../contract/define';
import { AssetType, CsvIds, Id, LocalDate, PageQuery } from '../primitives';
import { AssetSummary } from './assets';
import { PersonSummary } from './people';

export const SearchQuery = PageQuery.extend({
  /** Free text, parsed into people, places, years, and CLIP text, e.g. "Alice at the beach 2023". */
  q: z.string().trim().max(200).optional(),
  personIds: CsvIds.optional(),
  /** `all`: every listed person is in the photo. `only`: nobody else is. */
  personMode: z.enum(['all', 'only']).default('all'),
  /** At least this many faces (3 finds group photos). */
  minFaces: z.coerce.number().int().min(1).max(50).optional(),
  tag: z.string().trim().max(60).optional(),
  city: z.string().trim().max(120).optional(),
  country: z.string().trim().max(120).optional(),
  type: AssetType.optional(),
  from: LocalDate.optional(),
  to: LocalDate.optional(),
});

export const SearchSuggestion = z
  .object({
    kind: z.enum(['person', 'place', 'tag', 'date', 'text']),
    label: z.string(),
    /** Value to put in the matching query parameter. */
    value: z.string(),
  })
  .meta({ id: 'SearchSuggestion' });

const ExploreTile = z.object({
  label: z.string(),
  value: z.string(),
  count: z.number().int().nonnegative(),
  coverUrl: z.string().nullable(),
});

export const searchEndpoints = defineEndpoints({
  'search.query': {
    method: 'GET',
    path: '/api/search',
    auth: 'user',
    tag: 'search',
    summary: 'Semantic search with people, place, date, tag, and type filters',
    query: SearchQuery,
    response: z.object({
      items: z.array(AssetSummary),
      nextCursor: z.string().nullable(),
      parsed: z.object({
        text: z.string().nullable(),
        personIds: z.array(Id),
        year: z.number().int().nullable(),
      }),
    }),
    stability: 'draft',
  },
  'search.suggestions': {
    method: 'GET',
    path: '/api/search/suggestions',
    auth: 'user',
    tag: 'search',
    summary: 'Suggestions while typing',
    query: z.object({ q: z.string().trim().max(200) }),
    response: z.object({ suggestions: z.array(SearchSuggestion) }),
    stability: 'draft',
  },
  'explore.get': {
    method: 'GET',
    path: '/api/explore',
    auth: 'user',
    tag: 'search',
    summary: 'Explore page: people, places, things, videos, screenshots',
    response: z.object({
      people: z.array(PersonSummary),
      places: z.array(ExploreTile),
      things: z.array(ExploreTile),
      videos: ExploreTile,
      screenshots: ExploreTile,
    }),
    stability: 'draft',
  },
});
