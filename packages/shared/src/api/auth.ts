import { z } from 'zod';
import { defineEndpoints } from '../contract/define';
import {
  AssetType,
  Bytes,
  Email,
  EmailInput,
  Id,
  IsoDateTime,
  Password,
  PersonName,
  UserRole,
} from '../primitives';

export const CurrentUser = z
  .object({
    id: Id,
    email: Email,
    name: z.string(),
    role: UserRole,
    createdAt: IsoDateTime,
  })
  .meta({ id: 'CurrentUser' });
export type CurrentUser = z.infer<typeof CurrentUser>;

export const UserResponse = z.object({ user: CurrentUser });

export const SetupRequest = z.object({
  name: PersonName,
  email: EmailInput,
  password: Password,
  serverName: z.string().trim().min(1).max(80).optional(),
});
export type SetupRequest = z.input<typeof SetupRequest>;

export const LoginRequest = z.object({
  email: EmailInput,
  password: z.string().min(1).max(200),
});
export type LoginRequest = z.input<typeof LoginRequest>;

export const MeResponse = z
  .object({
    user: CurrentUser,
    via: z.enum(['session', 'device']),
    deviceId: Id.nullable(),
  })
  .meta({ id: 'Me' });
export type MeResponse = z.infer<typeof MeResponse>;

export const ChangePasswordRequest = z.object({
  currentPassword: z.string().min(1).max(200),
  newPassword: Password,
});

export const UpdateProfileRequest = z
  .object({
    name: PersonName.optional(),
    email: EmailInput.optional(),
  })
  .refine((value) => value.name !== undefined || value.email !== undefined, {
    message: 'Nothing to update',
  });

const TypeUsage = z.object({ count: z.number().int().nonnegative(), bytes: Bytes });

export const StorageUsage = z
  .object({
    usedBytes: Bytes,
    quotaBytes: Bytes.nullable(),
    assetCount: z.number().int().nonnegative(),
    byType: z.record(AssetType, TypeUsage),
  })
  .meta({ id: 'StorageUsage' });
export type StorageUsage = z.infer<typeof StorageUsage>;

export const authEndpoints = defineEndpoints({
  'setup.complete': {
    method: 'POST',
    path: '/api/setup',
    auth: 'public',
    tag: 'setup',
    summary: 'First-run setup: create the admin account and sign in',
    description: 'Only works while the server has no accounts. Sets the session cookie.',
    body: SetupRequest,
    response: UserResponse,
    successStatus: 201,
    errors: ['setup_already_done', 'rate_limited'],
    stability: 'stable',
  },
  'auth.login': {
    method: 'POST',
    path: '/api/auth/login',
    auth: 'public',
    tag: 'auth',
    summary: 'Sign in with email and password (sets the session cookie)',
    description: 'Phones sign in through `POST /api/devices/pair` instead, to get a device token.',
    body: LoginRequest,
    response: UserResponse,
    errors: ['invalid_credentials', 'account_disabled', 'rate_limited'],
    stability: 'stable',
  },
  'auth.logout': {
    method: 'POST',
    path: '/api/auth/logout',
    auth: 'user',
    tag: 'auth',
    summary: 'Sign out',
    description: 'Ends the browser session, or revokes the device token when called by a phone.',
    responseKind: 'empty',
    successStatus: 204,
    stability: 'stable',
  },
  'auth.me': {
    method: 'GET',
    path: '/api/auth/me',
    auth: 'user',
    tag: 'auth',
    summary: 'The signed-in person and how they are authenticated',
    response: MeResponse,
    stability: 'stable',
  },
  'auth.changePassword': {
    method: 'POST',
    path: '/api/auth/password',
    auth: 'user',
    tag: 'auth',
    summary: 'Change password; signs out all other browser sessions',
    body: ChangePasswordRequest,
    responseKind: 'empty',
    successStatus: 204,
    errors: ['invalid_credentials'],
    stability: 'stable',
  },
  'me.update': {
    method: 'PATCH',
    path: '/api/me',
    auth: 'user',
    tag: 'auth',
    summary: 'Update your name or email',
    body: UpdateProfileRequest,
    response: UserResponse,
    errors: ['conflict'],
    stability: 'stable',
  },
  'me.storage': {
    method: 'GET',
    path: '/api/me/storage',
    auth: 'user',
    tag: 'auth',
    summary: 'Storage used by your library and your quota',
    response: StorageUsage,
    stability: 'stable',
  },
});
