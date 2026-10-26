import { z } from 'zod';
import { defineEndpoints } from '../contract/define';
import { Id, IdParams, IsoDateTime, LocalDate, PageQuery, UserRef, paginated } from '../primitives';
import { AssetSummary } from './assets';
import { PersonSummary } from './people';

export const AlbumRole = z.enum(['owner', 'contributor', 'viewer']);
export const AlbumMemberRole = z.enum(['contributor', 'viewer']);

export const AlbumSummary = z
  .object({
    id: Id,
    title: z.string(),
    owner: UserRef,
    assetCount: z.number().int().nonnegative(),
    coverUrl: z.string().nullable(),
    /** Has rules that add photos of chosen people automatically. */
    isLive: z.boolean(),
    /** Your role in this album. */
    role: AlbumRole,
    /** Pending invitation you haven't joined yet. */
    invited: z.boolean(),
    showInTimeline: z.boolean(),
    updatedAt: IsoDateTime,
  })
  .meta({ id: 'AlbumSummary' });
export type AlbumSummary = z.infer<typeof AlbumSummary>;

export const AlbumMember = z
  .object({
    user: UserRef,
    role: AlbumMemberRole,
    status: z.enum(['invited', 'joined']),
    showInTimeline: z.boolean(),
  })
  .meta({ id: 'AlbumMember' });

export const AlbumRule = z
  .object({
    id: Id,
    /** The member whose library the person belongs to. */
    userId: Id,
    person: z.object({ id: Id, name: z.string().nullable() }),
    startDate: LocalDate.nullable(),
  })
  .meta({ id: 'AlbumRule' });

export const AlbumDetail = AlbumSummary.extend({
  description: z.string().nullable(),
  members: z.array(AlbumMember),
  rules: z.array(AlbumRule),
}).meta({ id: 'AlbumDetail' });
export type AlbumDetail = z.infer<typeof AlbumDetail>;

const AlbumParams = IdParams;
const AlbumMemberParams = z.object({ id: Id, userId: Id });
const AssetIds = z.object({ assetIds: z.array(Id).min(1).max(1000) });

export const albumEndpoints = defineEndpoints({
  'albums.list': {
    method: 'GET',
    path: '/api/albums',
    auth: 'user',
    tag: 'albums',
    summary: 'Albums you own or that are shared with you (including pending invitations)',
    query: z.object({ scope: z.enum(['all', 'owned', 'shared']).default('all') }),
    response: z.object({ albums: z.array(AlbumSummary) }),
    stability: 'draft',
  },
  'albums.create': {
    method: 'POST',
    path: '/api/albums',
    auth: 'user',
    tag: 'albums',
    summary: 'Create an album, optionally with some of your assets',
    body: z.object({
      title: z.string().trim().min(1).max(200),
      description: z.string().trim().max(2000).optional(),
      assetIds: z.array(Id).max(1000).optional(),
    }),
    response: z.object({ album: AlbumDetail }),
    successStatus: 201,
    stability: 'draft',
  },
  'albums.get': {
    method: 'GET',
    path: '/api/albums/:id',
    auth: 'user',
    tag: 'albums',
    summary: 'One album with members and rules',
    params: AlbumParams,
    response: z.object({ album: AlbumDetail }),
    errors: ['not_found'],
    stability: 'draft',
  },
  'albums.update': {
    method: 'PATCH',
    path: '/api/albums/:id',
    auth: 'user',
    tag: 'albums',
    summary: 'Rename an album, change its description or cover (owner only)',
    params: AlbumParams,
    body: z.object({
      title: z.string().trim().min(1).max(200).optional(),
      description: z.string().trim().max(2000).nullable().optional(),
      coverAssetId: Id.nullable().optional(),
    }),
    response: z.object({ album: AlbumDetail }),
    errors: ['not_found', 'forbidden'],
    stability: 'draft',
  },
  'albums.delete': {
    method: 'DELETE',
    path: '/api/albums/:id',
    auth: 'user',
    tag: 'albums',
    summary: 'Delete an album (owner only). Photos stay in their owners’ libraries.',
    params: AlbumParams,
    responseKind: 'empty',
    successStatus: 204,
    errors: ['not_found', 'forbidden'],
    stability: 'draft',
  },
  'albums.assets': {
    method: 'GET',
    path: '/api/albums/:id/assets',
    auth: 'user',
    tag: 'albums',
    summary: 'Assets in an album, newest first',
    params: AlbumParams,
    query: PageQuery,
    response: paginated(AssetSummary),
    errors: ['not_found'],
    stability: 'draft',
  },
  'albums.addAssets': {
    method: 'POST',
    path: '/api/albums/:id/assets',
    auth: 'user',
    tag: 'albums',
    summary: 'Add your assets to an album (owner or contributor)',
    params: AlbumParams,
    body: AssetIds,
    response: z.object({ added: z.number().int().nonnegative() }),
    errors: ['not_found', 'forbidden'],
    stability: 'draft',
  },
  'albums.removeAssets': {
    method: 'POST',
    path: '/api/albums/:id/assets/remove',
    auth: 'user',
    tag: 'albums',
    summary: 'Remove assets from an album (owner, or whoever added them)',
    params: AlbumParams,
    body: AssetIds,
    response: z.object({ removed: z.number().int().nonnegative() }),
    errors: ['not_found', 'forbidden'],
    stability: 'draft',
  },
  'albums.join': {
    method: 'POST',
    path: '/api/albums/:id/join',
    auth: 'user',
    tag: 'albums',
    summary: 'Accept an album invitation',
    params: AlbumParams,
    response: z.object({ album: AlbumDetail }),
    errors: ['not_found'],
    stability: 'draft',
  },
  'albums.members.add': {
    method: 'POST',
    path: '/api/albums/:id/members',
    auth: 'user',
    tag: 'albums',
    summary: 'Invite someone on this server to an album (owner only)',
    params: AlbumParams,
    body: z.object({ userId: Id, role: AlbumMemberRole.default('viewer') }),
    response: z.object({ member: AlbumMember }),
    successStatus: 201,
    errors: ['not_found', 'forbidden', 'conflict'],
    stability: 'draft',
  },
  'albums.members.update': {
    method: 'PATCH',
    path: '/api/albums/:id/members/:userId',
    auth: 'user',
    tag: 'albums',
    summary:
      'Owner changes a member’s role; a member changes their own "Show in my timeline" switch',
    params: AlbumMemberParams,
    body: z.object({
      role: AlbumMemberRole.optional(),
      showInTimeline: z.boolean().optional(),
    }),
    response: z.object({ member: AlbumMember }),
    errors: ['not_found', 'forbidden'],
    stability: 'draft',
  },
  'albums.members.remove': {
    method: 'DELETE',
    path: '/api/albums/:id/members/:userId',
    auth: 'user',
    tag: 'albums',
    summary: 'Remove a member (owner), or leave an album (yourself)',
    params: AlbumMemberParams,
    responseKind: 'empty',
    successStatus: 204,
    errors: ['not_found', 'forbidden'],
    stability: 'draft',
  },
  'albums.rules.add': {
    method: 'POST',
    path: '/api/albums/:id/rules',
    auth: 'user',
    tag: 'albums',
    summary: 'Link one of your own people to a live album, optionally from a start date',
    params: AlbumParams,
    body: z.object({ personId: Id, startDate: LocalDate.optional() }),
    response: z.object({ rule: AlbumRule }),
    successStatus: 201,
    errors: ['not_found', 'forbidden', 'conflict'],
    stability: 'draft',
  },
  'albums.rules.remove': {
    method: 'DELETE',
    path: '/api/albums/:id/rules/:ruleId',
    auth: 'user',
    tag: 'albums',
    summary: 'Unlink a person from a live album (whoever linked it, or the owner)',
    params: z.object({ id: Id, ruleId: Id }),
    responseKind: 'empty',
    successStatus: 204,
    errors: ['not_found', 'forbidden'],
    stability: 'draft',
  },
  'albums.ruleSuggestions': {
    method: 'GET',
    path: '/api/albums/:id/rule-suggestions',
    auth: 'user',
    tag: 'albums',
    summary: '"Is this them?" matches between a shared person and people in your library',
    params: AlbumParams,
    response: z.object({
      suggestions: z.array(
        z.object({
          ruleId: Id,
          sharedBy: UserRef,
          sharedPersonName: z.string().nullable(),
          candidate: PersonSummary,
          similarity: z.number().min(0).max(1),
        }),
      ),
    }),
    errors: ['not_found'],
    stability: 'draft',
  },
});
