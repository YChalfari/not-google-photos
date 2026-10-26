import { z } from 'zod';

export const API_ERROR_CODES = [
  'bad_request',
  'validation_failed',
  'unauthorized',
  'forbidden',
  'not_found',
  'conflict',
  'rate_limited',
  'payload_too_large',
  'unsupported_media_type',
  'setup_required',
  'setup_already_done',
  'invalid_credentials',
  'account_disabled',
  'invite_invalid',
  'pairing_code_invalid',
  'library_unavailable',
  'quota_exceeded',
  'checksum_mismatch',
  'not_implemented',
  'internal_error',
] as const;

export const ApiErrorCode = z.enum(API_ERROR_CODES);
export type ApiErrorCode = z.infer<typeof ApiErrorCode>;

/** Every non-2xx JSON response has this shape. */
export const ApiErrorBody = z
  .object({
    error: z.object({
      code: ApiErrorCode,
      message: z.string(),
      details: z.unknown().optional(),
    }),
  })
  .meta({ id: 'ApiError' });
export type ApiErrorBody = z.infer<typeof ApiErrorBody>;

export const DEFAULT_ERROR_STATUS: Record<ApiErrorCode, number> = {
  bad_request: 400,
  validation_failed: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  rate_limited: 429,
  payload_too_large: 413,
  unsupported_media_type: 415,
  setup_required: 409,
  setup_already_done: 409,
  invalid_credentials: 401,
  account_disabled: 403,
  invite_invalid: 410,
  pairing_code_invalid: 400,
  library_unavailable: 503,
  quota_exceeded: 507,
  checksum_mismatch: 422,
  not_implemented: 501,
  internal_error: 500,
};
