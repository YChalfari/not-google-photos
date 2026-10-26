import type { z } from 'zod';
import type { ApiErrorCode } from '../errors';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/**
 * Who may call an endpoint.
 * - `public`: anyone, no credentials.
 * - `user`: a signed-in person, via the browser session cookie or a phone's device token.
 * - `admin`: like `user`, and the person must be an admin.
 * - `device`: device token only (phone background sync).
 * - `signed`: a signed, short-lived media URL; no cookie or token needed.
 */
export type AuthPolicy = 'public' | 'user' | 'admin' | 'device' | 'signed';

/**
 * `stable` endpoints are implemented or relied on by the phone app; change them only in a
 * backwards-compatible way. `draft` endpoints are placeholders whose shapes the owning piece
 * may still change.
 */
export type Stability = 'stable' | 'draft';

export type ApiTag =
  | 'server'
  | 'setup'
  | 'auth'
  | 'invites'
  | 'admin'
  | 'users'
  | 'devices'
  | 'media'
  | 'assets'
  | 'timeline'
  | 'people'
  | 'search'
  | 'albums'
  | 'memories';

export interface EndpointSpec {
  readonly method: HttpMethod;
  /** Hono-style path with `:param` segments, e.g. `/api/devices/:id`. */
  readonly path: `/api/${string}`;
  readonly auth: AuthPolicy;
  readonly tag: ApiTag;
  readonly summary: string;
  readonly description?: string;
  readonly params?: z.ZodObject;
  readonly query?: z.ZodObject;
  /** JSON body, or for `bodyKind: 'multipart'` the text fields sent before the file part. */
  readonly body?: z.ZodType;
  readonly bodyKind?: 'json' | 'multipart';
  /** JSON response body. Omit for `responseKind: 'empty' | 'binary'`. */
  readonly response?: z.ZodType;
  readonly responseKind?: 'json' | 'empty' | 'binary';
  readonly successStatus?: 200 | 201 | 202 | 204;
  /** Error codes the caller should be ready for, beyond validation and auth errors. */
  readonly errors?: readonly ApiErrorCode[];
  readonly stability: Stability;
}

export function defineEndpoints<const T extends Record<string, EndpointSpec>>(defs: T): T {
  return defs;
}

export type ParamsInput<E> = E extends { params: infer S extends z.ZodType } ? z.input<S> : undefined;
export type ParamsOutput<E> = E extends { params: infer S extends z.ZodType }
  ? z.output<S>
  : undefined;
export type QueryInput<E> = E extends { query: infer S extends z.ZodType } ? z.input<S> : undefined;
export type QueryOutput<E> = E extends { query: infer S extends z.ZodType } ? z.output<S> : undefined;
export type BodyInput<E> = E extends { body: infer S extends z.ZodType } ? z.input<S> : undefined;
export type BodyOutput<E> = E extends { body: infer S extends z.ZodType } ? z.output<S> : undefined;
export type ResponseInput<E> = E extends { response: infer S extends z.ZodType } ? z.input<S> : void;
export type ResponseOutput<E> = E extends { response: infer S extends z.ZodType }
  ? z.output<S>
  : void;

/** Fills `:param` segments, e.g. `buildPath('/api/devices/:id', { id })`. */
export function buildPath(path: string, params?: Record<string, string | number>): string {
  return path.replace(/:([A-Za-z0-9_]+)/g, (_match, name: string) => {
    const value = params?.[name];
    if (value === undefined) throw new Error(`Missing path parameter "${name}" for ${path}`);
    return encodeURIComponent(String(value));
  });
}
