import { z } from 'zod';
import { defineEndpoints } from '../contract/define';
import {
  BaseUrl,
  Bytes,
  Email,
  Id,
  IdParams,
  IsoDateTime,
  PersonName,
  UserRole,
} from '../primitives';
import { LibraryStatus } from './server';

export const AdminUser = z
  .object({
    id: Id,
    email: Email,
    name: z.string(),
    role: UserRole,
    status: z.enum(['active', 'disabled']),
    createdAt: IsoDateTime,
    lastLoginAt: IsoDateTime.nullable(),
    deviceCount: z.number().int().nonnegative(),
    storage: z.object({
      usedBytes: Bytes,
      quotaBytes: Bytes.nullable(),
      assetCount: z.number().int().nonnegative(),
    }),
  })
  .meta({ id: 'AdminUser' });
export type AdminUser = z.infer<typeof AdminUser>;

export const UpdateUserRequest = z
  .object({
    name: PersonName.optional(),
    role: UserRole.optional(),
    quotaBytes: Bytes.nullable().optional(),
    disabled: z.boolean().optional(),
  })
  .refine((value) => Object.values(value).some((field) => field !== undefined), {
    message: 'Nothing to update',
  });
export type UpdateUserRequest = z.input<typeof UpdateUserRequest>;

export const ServerSettings = z
  .object({
    serverId: Id,
    name: z.string(),
    version: z.string(),
    homeUrl: BaseUrl.nullable(),
    remoteUrl: BaseUrl.nullable(),
    /** Values from the environment, used when the admin hasn't set an address here. */
    defaults: z.object({ homeUrl: BaseUrl.nullable(), remoteUrl: BaseUrl.nullable() }),
    library: LibraryStatus,
    /** Files whose nightly re-hash did not match. The bytes are left as they are. */
    files: z.object({
      problemCount: z.number().int().nonnegative(),
      problems: z.array(
        z.object({
          id: Id,
          problem: z.enum(['missing', 'mismatch']),
        }),
      ),
    }),
  })
  .meta({ id: 'ServerSettings' });
export type ServerSettings = z.infer<typeof ServerSettings>;

export const UpdateServerSettingsRequest = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  homeUrl: BaseUrl.nullable().optional(),
  remoteUrl: BaseUrl.nullable().optional(),
});
export type UpdateServerSettingsRequest = z.input<typeof UpdateServerSettingsRequest>;

export const adminEndpoints = defineEndpoints({
  'admin.users.list': {
    method: 'GET',
    path: '/api/admin/users',
    auth: 'admin',
    tag: 'admin',
    summary: 'Everyone on this server, with storage and device counts',
    response: z.object({ users: z.array(AdminUser) }),
    stability: 'stable',
  },
  'admin.users.update': {
    method: 'PATCH',
    path: '/api/admin/users/:id',
    auth: 'admin',
    tag: 'admin',
    summary: 'Change role, quota, name, or disable an account',
    description:
      'Disabling signs the person out everywhere. The last active admin cannot be demoted or disabled.',
    params: IdParams,
    body: UpdateUserRequest,
    response: z.object({ user: AdminUser }),
    errors: ['not_found', 'conflict'],
    stability: 'stable',
  },
  'admin.server.get': {
    method: 'GET',
    path: '/api/admin/server',
    auth: 'admin',
    tag: 'admin',
    summary: 'Server name, addresses, and library status',
    response: ServerSettings,
    stability: 'stable',
  },
  'admin.server.update': {
    method: 'PATCH',
    path: '/api/admin/server',
    auth: 'admin',
    tag: 'admin',
    summary: 'Rename the server or set its home and remote addresses',
    description: 'Send `null` for an address to fall back to the environment default.',
    body: UpdateServerSettingsRequest,
    response: ServerSettings,
    stability: 'stable',
  },
});
