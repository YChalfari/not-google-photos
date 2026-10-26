import { z } from 'zod';
import { defineEndpoints } from '../contract/define';
import { Id, IdParams, IsoDateTime, LocalDate } from '../primitives';
import { AssetSummary } from './assets';

export const MemorySummary = z
  .object({
    id: Id,
    /** `on_this_day` for now; more kinds (trips, year recap) later. */
    kind: z.string(),
    /** The local date the memory is for. */
    date: LocalDate,
    title: z.string(),
    subtitle: z.string().nullable(),
    assetCount: z.number().int().nonnegative(),
    coverUrl: z.string().nullable(),
    seenAt: IsoDateTime.nullable(),
    dismissedAt: IsoDateTime.nullable(),
  })
  .meta({ id: 'MemorySummary' });
export type MemorySummary = z.infer<typeof MemorySummary>;

export const MemoryDetail = MemorySummary.extend({
  assets: z.array(AssetSummary),
}).meta({ id: 'MemoryDetail' });

export const UpcomingMemory = z
  .object({
    id: Id,
    date: LocalDate,
    title: z.string(),
    subtitle: z.string().nullable(),
    assetCount: z.number().int().positive(),
    /** Signed cover thumbnail URL, valid long enough to download it when scheduling. */
    coverUrl: z.string().nullable(),
  })
  .meta({ id: 'UpcomingMemory' });
export type UpcomingMemory = z.infer<typeof UpcomingMemory>;

export const memoryEndpoints = defineEndpoints({
  'memories.list': {
    method: 'GET',
    path: '/api/memories',
    auth: 'user',
    tag: 'memories',
    summary: 'Your memories in a date range (defaults to today), excluding dismissed ones',
    query: z.object({ from: LocalDate.optional(), to: LocalDate.optional() }),
    response: z.object({ memories: z.array(MemorySummary) }),
    stability: 'draft',
  },
  'memories.get': {
    method: 'GET',
    path: '/api/memories/:id',
    auth: 'user',
    tag: 'memories',
    summary: 'One memory with its photos',
    params: IdParams,
    response: z.object({ memory: MemoryDetail }),
    errors: ['not_found'],
    stability: 'draft',
  },
  'memories.update': {
    method: 'PATCH',
    path: '/api/memories/:id',
    auth: 'user',
    tag: 'memories',
    summary: 'Mark a memory seen, dismissed, or notified',
    params: IdParams,
    body: z.object({
      seen: z.boolean().optional(),
      dismissed: z.boolean().optional(),
      notified: z.boolean().optional(),
    }),
    response: z.object({ memory: MemorySummary }),
    errors: ['not_found'],
    stability: 'draft',
  },
  'memories.upcoming': {
    method: 'GET',
    path: '/api/memories/upcoming',
    auth: 'user',
    tag: 'memories',
    summary: 'Memories for the next few days, for scheduling local notifications on the phone',
    query: z.object({ days: z.coerce.number().int().min(1).max(14).default(7) }),
    response: z.object({ memories: z.array(UpcomingMemory) }),
    stability: 'stable',
  },
});
