import { z } from 'zod';
import {
  ASSET_TYPES,
  DEVICE_PLATFORMS,
  MAX_PAGE_SIZE,
  MEDIA_VARIANTS,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  USER_ROLES,
} from './constants';

export const Id = z.uuid();

/** ISO 8601 instant, e.g. `2026-10-26T08:52:00.000Z`. */
export const IsoDateTime = z.iso.datetime({ offset: true });

/** Calendar date without a time zone, e.g. `2026-10-26`. */
export const LocalDate = z.iso.date();

/** SHA-1 of a file's bytes as hex. Accepts upper case, normalizes to lower case. */
export const Sha1Hex = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[0-9a-f]{40}$/, 'Expected a 40-character hex SHA-1');

export const EmailInput = z.string().trim().toLowerCase().pipe(z.email().max(254));
export const Email = z.email();

export const Password = z.string().min(PASSWORD_MIN_LENGTH).max(PASSWORD_MAX_LENGTH);

export const PersonName = z.string().trim().min(1).max(80);

/** Absolute http(s) URL without a trailing slash, e.g. `http://192.168.1.20:4810`. */
export const BaseUrl = z
  .url({ protocol: /^https?$/ })
  .transform((value) => value.replace(/\/+$/, ''));

export const UserRole = z.enum(USER_ROLES);
export type UserRole = z.infer<typeof UserRole>;
export const DevicePlatform = z.enum(DEVICE_PLATFORMS);
export type DevicePlatform = z.infer<typeof DevicePlatform>;
export const AssetType = z.enum(ASSET_TYPES);
export type AssetType = z.infer<typeof AssetType>;
export const MediaVariant = z.enum(MEDIA_VARIANTS);
export type MediaVariant = z.infer<typeof MediaVariant>;

export const Bytes = z.number().int().nonnegative();

/** Query-string boolean: accepts `true/false/1/0/yes/no`. */
export const QueryBool = z.stringbool();

/** Comma-separated list of ids in a query string, e.g. `?personIds=a,b`. */
export const CsvIds = z
  .string()
  .transform((value) =>
    value
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean),
  )
  .pipe(z.array(Id).max(20));

export const PageQuery = z.object({
  cursor: z.string().max(500).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(100),
});

export function paginated<T extends z.ZodType>(item: T) {
  return z.object({
    items: z.array(item),
    nextCursor: z.string().nullable(),
  });
}

export const UserRef = z.object({ id: Id, name: z.string() });

export const IdParams = z.object({ id: Id });
