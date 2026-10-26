import { z } from 'zod';
import { INVITE_DEFAULT_TTL_DAYS, INVITE_MAX_TTL_DAYS } from '../constants';
import { defineEndpoints } from '../contract/define';
import {
  Bytes,
  Email,
  EmailInput,
  Id,
  IdParams,
  IsoDateTime,
  Password,
  PersonName,
  UserRef,
  UserRole,
} from '../primitives';
import { UserResponse } from './auth';

export const InviteStatus = z.enum(['pending', 'accepted', 'revoked', 'expired']);
export type InviteStatus = z.infer<typeof InviteStatus>;

export const Invite = z
  .object({
    id: Id,
    email: Email.nullable(),
    name: z.string().nullable(),
    role: UserRole,
    quotaBytes: Bytes.nullable(),
    status: InviteStatus,
    createdAt: IsoDateTime,
    expiresAt: IsoDateTime,
    createdBy: UserRef.nullable(),
    acceptedBy: UserRef.nullable(),
    acceptedAt: IsoDateTime.nullable(),
  })
  .meta({ id: 'Invite' });
export type Invite = z.infer<typeof Invite>;

export const CreateInviteRequest = z.object({
  /** Locks the invite to this address. */
  email: EmailInput.optional(),
  /** Pre-fills the name on the acceptance page. */
  name: PersonName.optional(),
  role: UserRole.default('member'),
  expiresInDays: z.number().int().min(1).max(INVITE_MAX_TTL_DAYS).default(INVITE_DEFAULT_TTL_DAYS),
  quotaBytes: Bytes.nullable().default(null),
});
export type CreateInviteRequest = z.input<typeof CreateInviteRequest>;

export const CreateInviteResponse = z.object({
  invite: Invite,
  /** The secret part of the link. Only returned once; the server stores a hash. */
  token: z.string(),
  /** App path for the link, e.g. `/invite/ngpi_...`. */
  path: z.string(),
  /** Best absolute link: remote address, else home address, else the address the admin used. */
  url: z.url(),
});
export type CreateInviteResponse = z.infer<typeof CreateInviteResponse>;

export const InviteTokenRequest = z.object({ token: z.string().min(10).max(200) });

export const InviteLookupResponse = z.object({
  serverName: z.string(),
  invite: z.object({
    email: Email.nullable(),
    name: z.string().nullable(),
    role: UserRole,
    expiresAt: IsoDateTime,
    invitedBy: z.string().nullable(),
  }),
});
export type InviteLookupResponse = z.infer<typeof InviteLookupResponse>;

export const AcceptInviteRequest = z.object({
  token: z.string().min(10).max(200),
  name: PersonName,
  email: EmailInput,
  password: Password,
});
export type AcceptInviteRequest = z.input<typeof AcceptInviteRequest>;

export const inviteEndpoints = defineEndpoints({
  'invites.list': {
    method: 'GET',
    path: '/api/invites',
    auth: 'admin',
    tag: 'invites',
    summary: 'All invites, newest first',
    response: z.object({ invites: z.array(Invite) }),
    stability: 'stable',
  },
  'invites.create': {
    method: 'POST',
    path: '/api/invites',
    auth: 'admin',
    tag: 'invites',
    summary: 'Create an invite link (shown as a link and QR code)',
    body: CreateInviteRequest,
    response: CreateInviteResponse,
    successStatus: 201,
    stability: 'stable',
  },
  'invites.revoke': {
    method: 'DELETE',
    path: '/api/invites/:id',
    auth: 'admin',
    tag: 'invites',
    summary: 'Revoke a pending invite',
    params: IdParams,
    responseKind: 'empty',
    successStatus: 204,
    errors: ['not_found', 'conflict'],
    stability: 'stable',
  },
  'invites.lookup': {
    method: 'POST',
    path: '/api/invites/lookup',
    auth: 'public',
    tag: 'invites',
    summary: 'Check an invite token before showing the sign-up form',
    body: InviteTokenRequest,
    response: InviteLookupResponse,
    errors: ['invite_invalid', 'rate_limited'],
    stability: 'stable',
  },
  'invites.accept': {
    method: 'POST',
    path: '/api/invites/accept',
    auth: 'public',
    tag: 'invites',
    summary: 'Accept an invite: create the account, set its password, and sign in',
    body: AcceptInviteRequest,
    response: UserResponse,
    successStatus: 201,
    errors: ['invite_invalid', 'conflict', 'rate_limited'],
    stability: 'stable',
  },
});
