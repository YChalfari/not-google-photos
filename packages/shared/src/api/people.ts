import { z } from 'zod';
import { defineEndpoints } from '../contract/define';
import { Id, IdParams, PageQuery, PersonName, QueryBool, paginated } from '../primitives';
import { AssetSummary, FaceBox } from './assets';

export const PersonSummary = z
  .object({
    id: Id,
    name: z.string().nullable(),
    faceCount: z.number().int().nonnegative(),
    isHidden: z.boolean(),
    hideFromMemories: z.boolean(),
    coverUrl: z.string().nullable(),
  })
  .meta({ id: 'PersonSummary' });
export type PersonSummary = z.infer<typeof PersonSummary>;

export const FaceSummary = z
  .object({
    id: Id,
    assetId: Id,
    box: FaceBox,
    personId: Id.nullable(),
    ignored: z.boolean(),
  })
  .meta({ id: 'FaceSummary' });

export const peopleEndpoints = defineEndpoints({
  'people.list': {
    method: 'GET',
    path: '/api/people',
    auth: 'user',
    tag: 'people',
    summary: 'People in your library, most photographed first',
    query: z.object({ includeHidden: QueryBool.default(false) }),
    response: z.object({ people: z.array(PersonSummary) }),
    stability: 'draft',
  },
  'people.get': {
    method: 'GET',
    path: '/api/people/:id',
    auth: 'user',
    tag: 'people',
    summary: 'One person',
    params: IdParams,
    response: z.object({ person: PersonSummary }),
    errors: ['not_found'],
    stability: 'draft',
  },
  'people.update': {
    method: 'PATCH',
    path: '/api/people/:id',
    auth: 'user',
    tag: 'people',
    summary: 'Name, hide, or keep a person out of memories',
    params: IdParams,
    body: z.object({
      name: PersonName.nullable().optional(),
      isHidden: z.boolean().optional(),
      hideFromMemories: z.boolean().optional(),
      coverFaceId: Id.optional(),
    }),
    response: z.object({ person: PersonSummary }),
    errors: ['not_found'],
    stability: 'draft',
  },
  'people.merge': {
    method: 'POST',
    path: '/api/people/:id/merge',
    auth: 'user',
    tag: 'people',
    summary: 'Merge other people into this one',
    params: IdParams,
    body: z.object({ sourcePersonIds: z.array(Id).min(1).max(50) }),
    response: z.object({ person: PersonSummary }),
    errors: ['not_found'],
    stability: 'draft',
  },
  'people.assets': {
    method: 'GET',
    path: '/api/people/:id/assets',
    auth: 'user',
    tag: 'people',
    summary: 'Photos of one person, newest first',
    params: IdParams,
    query: PageQuery,
    response: paginated(AssetSummary),
    errors: ['not_found'],
    stability: 'draft',
  },
  'faces.update': {
    method: 'PATCH',
    path: '/api/faces/:id',
    auth: 'user',
    tag: 'people',
    summary: 'Move a face to another person, unassign it, or ignore it',
    description: 'Manual changes are never undone by re-clustering.',
    params: IdParams,
    body: z.object({
      personId: Id.nullable().optional(),
      ignored: z.boolean().optional(),
    }),
    response: z.object({ face: FaceSummary }),
    errors: ['not_found'],
    stability: 'draft',
  },
  'faces.notThisPerson': {
    method: 'POST',
    path: '/api/faces/:id/not-this-person',
    auth: 'user',
    tag: 'people',
    summary: 'Record "not this person" so clustering stops suggesting it',
    params: IdParams,
    body: z.object({ personId: Id }),
    responseKind: 'empty',
    successStatus: 204,
    errors: ['not_found'],
    stability: 'draft',
  },
});
