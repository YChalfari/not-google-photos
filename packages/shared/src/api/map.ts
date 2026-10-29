import { z } from 'zod';
import { defineEndpoints } from '../contract/define';
import { Id } from '../primitives';

export const mapEndpoints = defineEndpoints({
  'map.points': {
    method: 'GET',
    path: '/api/map',
    auth: 'user',
    tag: 'timeline',
    summary: 'Your photos that have a location',
    response: z.object({
      points: z.array(
        z.object({
          id: Id,
          latitude: z.number(),
          longitude: z.number(),
          thumbnailUrl: z.string().nullable(),
        }),
      ),
    }),
    stability: 'draft',
  },
});
