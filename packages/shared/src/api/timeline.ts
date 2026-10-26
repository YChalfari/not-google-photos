import { z } from 'zod';
import { defineEndpoints } from '../contract/define';
import { QueryBool } from '../primitives';
import { AssetSummary } from './assets';

export const TimelineScope = z.enum(['library', 'favorites', 'archive', 'trash']);

export const TimelineQuery = z.object({
  scope: TimelineScope.default('library'),
  /** Include shared albums you turned on "Show in my timeline" for. Ignored for archive and trash. */
  withShared: QueryBool.default(true),
});

export const TimelineBucket = z
  .object({
    /** Month in local time, `YYYY-MM`. */
    key: z.string().regex(/^\d{4}-\d{2}$/),
    count: z.number().int().nonnegative(),
  })
  .meta({ id: 'TimelineBucket' });

export const timelineEndpoints = defineEndpoints({
  'timeline.buckets': {
    method: 'GET',
    path: '/api/timeline/buckets',
    auth: 'user',
    tag: 'timeline',
    summary: 'Month buckets with counts, newest first (for the scrubber and lazy loading)',
    query: TimelineQuery,
    response: z.object({ buckets: z.array(TimelineBucket) }),
    stability: 'draft',
  },
  'timeline.bucket': {
    method: 'GET',
    path: '/api/timeline/buckets/:key',
    auth: 'user',
    tag: 'timeline',
    summary: 'Assets in one month bucket, newest first',
    params: z.object({ key: z.string().regex(/^\d{4}-\d{2}$/) }),
    query: TimelineQuery,
    response: z.object({ assets: z.array(AssetSummary) }),
    stability: 'draft',
  },
});
