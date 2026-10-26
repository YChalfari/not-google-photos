import { DEFAULT_ERROR_STATUS, type ApiErrorBody, type ApiErrorCode } from '@ngp/shared';
import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { z } from 'zod';
import {
  BlobNotFoundError,
  ChecksumMismatchError,
  LibraryUnavailableError,
  PayloadTooLargeError,
} from '../storage/provider';

export interface ApiErrorOptions {
  status?: number;
  details?: unknown;
  headers?: Record<string, string>;
}

/** Throw from handlers; the app turns it into the shared `{ error: { code, message } }` body. */
export class ApiError extends Error {
  readonly status: number;
  readonly details: unknown;
  readonly headers: Record<string, string> | undefined;

  constructor(
    readonly code: ApiErrorCode,
    message: string,
    options: ApiErrorOptions = {},
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = options.status ?? DEFAULT_ERROR_STATUS[code];
    this.details = options.details;
    this.headers = options.headers;
  }
}

export interface ValidationIssue {
  in: 'params' | 'query' | 'body';
  path: string;
  message: string;
}

export function validationError(error: z.ZodError, location: ValidationIssue['in']): ApiError {
  const issues: ValidationIssue[] = error.issues.map((issue) => ({
    in: location,
    path: issue.path.map(String).join('.'),
    message: issue.message,
  }));
  const first = issues[0];
  const message = first
    ? `Invalid ${first.path ? `${location}.${first.path}` : location}: ${first.message}`
    : 'The request is invalid';
  return new ApiError('validation_failed', message, { details: { issues } });
}

/** Maps errors thrown by lower layers (storage, validation) to API errors. */
export function toApiError(error: unknown): ApiError | null {
  if (error instanceof ApiError) return error;
  if (error instanceof LibraryUnavailableError) {
    return new ApiError('library_unavailable', error.message, { details: { library: error.status } });
  }
  if (error instanceof ChecksumMismatchError) {
    return new ApiError('checksum_mismatch', error.message, {
      details: { algorithm: error.algorithm, expected: error.expected, actual: error.actual },
    });
  }
  if (error instanceof PayloadTooLargeError) return new ApiError('payload_too_large', error.message);
  if (error instanceof BlobNotFoundError) {
    return new ApiError('not_found', 'The file is missing from the library folder');
  }
  if (error instanceof z.ZodError) return validationError(error, 'body');
  return null;
}

export function errorBody(error: ApiError): ApiErrorBody {
  return {
    error: {
      code: error.code,
      message: error.message,
      ...(error.details === undefined ? {} : { details: error.details }),
    },
  };
}

export function sendError(c: Context, error: ApiError): Response {
  for (const [name, value] of Object.entries(error.headers ?? {})) c.header(name, value);
  return c.json(errorBody(error), error.status as ContentfulStatusCode);
}

/** Postgres unique-violation, e.g. an email that is already taken. */
export function isUniqueViolation(error: unknown, constraint?: string): boolean {
  const cause = findPgError(error);
  return cause?.code === '23505' && (constraint === undefined || cause.constraint === constraint);
}

function findPgError(error: unknown): { code?: string; constraint?: string } | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current && typeof current === 'object'; depth += 1) {
    const candidate = current as { code?: unknown; constraint?: unknown; cause?: unknown };
    if (typeof candidate.code === 'string' && /^[0-9A-Z]{5}$/.test(candidate.code)) {
      return {
        code: candidate.code,
        constraint: typeof candidate.constraint === 'string' ? candidate.constraint : undefined,
      };
    }
    current = candidate.cause;
  }
  return undefined;
}
