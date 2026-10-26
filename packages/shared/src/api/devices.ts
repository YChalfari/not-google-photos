import { z } from 'zod';
import { defineEndpoints } from '../contract/define';
import { PairingCode, PairingPayload } from '../pairing';
import { BaseUrl, DevicePlatform, EmailInput, Id, IdParams, IsoDateTime } from '../primitives';
import { CurrentUser } from './auth';

export const Device = z
  .object({
    id: Id,
    name: z.string(),
    platform: DevicePlatform,
    model: z.string().nullable(),
    osVersion: z.string().nullable(),
    appVersion: z.string().nullable(),
    createdAt: IsoDateTime,
    lastSeenAt: IsoDateTime.nullable(),
    /** True when this request is authenticated with this device's token. */
    isCurrent: z.boolean(),
  })
  .meta({ id: 'Device' });
export type Device = z.infer<typeof Device>;

export const DeviceInfo = z
  .object({
    name: z.string().trim().min(1).max(80),
    platform: DevicePlatform,
    model: z.string().trim().max(120).optional(),
    osVersion: z.string().trim().max(60).optional(),
    appVersion: z.string().trim().max(60).optional(),
  })
  .meta({ id: 'DeviceInfo' });
export type DeviceInfo = z.input<typeof DeviceInfo>;

export const PairDeviceRequest = z
  .discriminatedUnion('method', [
    z.object({
      method: z.literal('code'),
      /** One-time code from the pairing QR code (or typed in, with or without the dash). */
      code: PairingCode,
      device: DeviceInfo,
    }),
    z.object({
      method: z.literal('password'),
      email: EmailInput,
      password: z.string().min(1).max(200),
      device: DeviceInfo,
    }),
  ])
  .meta({ id: 'PairDeviceRequest' });
export type PairDeviceRequest = z.input<typeof PairDeviceRequest>;

export const PairDeviceResponse = z
  .object({
    deviceId: Id,
    /** Send as `Authorization: Bearer <deviceToken>`. Shown once; store it in secure storage. */
    deviceToken: z.string(),
    user: CurrentUser,
    server: z.object({
      serverId: Id,
      name: z.string(),
      homeUrl: BaseUrl.nullable(),
      remoteUrl: BaseUrl.nullable(),
    }),
  })
  .meta({ id: 'PairDeviceResponse' });
export type PairDeviceResponse = z.infer<typeof PairDeviceResponse>;

export const PairingCodeResponse = z
  .object({
    id: Id,
    code: z.string(),
    expiresAt: IsoDateTime,
    payload: PairingPayload,
    /** The text to put in the QR code. */
    uri: z.string(),
  })
  .meta({ id: 'PairingCode' });
export type PairingCodeResponse = z.infer<typeof PairingCodeResponse>;

export const PairingCodeStatus = z
  .object({
    status: z.enum(['pending', 'used', 'expired']),
    expiresAt: IsoDateTime,
    device: Device.nullable(),
  })
  .meta({ id: 'PairingCodeStatus' });
export type PairingCodeStatus = z.infer<typeof PairingCodeStatus>;

export const deviceEndpoints = defineEndpoints({
  'devices.list': {
    method: 'GET',
    path: '/api/devices',
    auth: 'user',
    tag: 'devices',
    summary: 'Your paired phones and other devices',
    response: z.object({ devices: z.array(Device) }),
    stability: 'stable',
  },
  'devices.update': {
    method: 'PATCH',
    path: '/api/devices/:id',
    auth: 'user',
    tag: 'devices',
    summary: 'Rename one of your devices',
    params: IdParams,
    body: z.object({ name: z.string().trim().min(1).max(80) }),
    response: z.object({ device: Device }),
    errors: ['not_found'],
    stability: 'stable',
  },
  'devices.revoke': {
    method: 'DELETE',
    path: '/api/devices/:id',
    auth: 'user',
    tag: 'devices',
    summary: 'Revoke a device; its token stops working immediately',
    params: IdParams,
    responseKind: 'empty',
    successStatus: 204,
    errors: ['not_found'],
    stability: 'stable',
  },
  'devices.createPairingCode': {
    method: 'POST',
    path: '/api/devices/pairing-codes',
    auth: 'user',
    tag: 'devices',
    summary: 'Create a one-time pairing code and the QR payload for it',
    description: 'Codes expire after 10 minutes and work once.',
    response: PairingCodeResponse,
    successStatus: 201,
    stability: 'stable',
  },
  'devices.pairingCodeStatus': {
    method: 'GET',
    path: '/api/devices/pairing-codes/:id',
    auth: 'user',
    tag: 'devices',
    summary: 'Whether a pairing code has been used yet (the web app polls this)',
    params: IdParams,
    response: PairingCodeStatus,
    errors: ['not_found'],
    stability: 'stable',
  },
  'devices.pair': {
    method: 'POST',
    path: '/api/devices/pair',
    auth: 'public',
    tag: 'devices',
    summary: 'Exchange a pairing code, or an email and password, for a device token',
    body: PairDeviceRequest,
    response: PairDeviceResponse,
    successStatus: 201,
    errors: ['pairing_code_invalid', 'invalid_credentials', 'account_disabled', 'rate_limited'],
    stability: 'stable',
  },
});
