import {
  endpoints,
  type BodyOutput,
  type Endpoint,
  type EndpointKey,
  type EndpointSpec,
  type ParamsOutput,
  type QueryOutput,
  type ResponseInput,
} from '@ngp/shared';
import type { Context, Hono } from 'hono';
import type { ContentfulStatusCode, StatusCode } from 'hono/utils/http-status';
import type { z } from 'zod';
import type { AppContext } from '../context';
import { resolveAuth, type AuthContext } from './auth';
import { assertSameOrigin } from './client';
import { ApiError, validationError } from './errors';
import type { AppEnv } from './types';

/** JSON bodies are small (the largest is a 5000-checksum batch, about 220 KB). */
export const MAX_JSON_BODY_BYTES = 2 * 1024 * 1024;

/** Public endpoints that set the session cookie, so they get the same-origin check too. */
const COOKIE_ISSUING_ENDPOINTS = new Set<string>(['setup.complete', 'auth.login', 'invites.accept']);

type AuthFor<E> = E extends { auth: 'public' | 'signed' } ? null : AuthContext;
type BodyFor<E> = E extends { bodyKind: 'multipart' } ? undefined : BodyOutput<E>;
type ResultFor<E> = E extends { responseKind: 'binary' }
  ? Response
  : E extends { response: z.ZodType }
    ? ResponseInput<E> | Response
    : void | Response;

export interface HandlerInput<K extends EndpointKey> {
  c: Context<AppEnv>;
  ctx: AppContext;
  auth: AuthFor<Endpoint<K>>;
  params: ParamsOutput<Endpoint<K>>;
  query: QueryOutput<Endpoint<K>>;
  /** Parsed JSON body. Multipart endpoints get `undefined` and read `c.req.raw` themselves. */
  body: BodyFor<Endpoint<K>>;
  /** Overrides the endpoint's success status, e.g. 200 for a duplicate upload. */
  setStatus: (status: ContentfulStatusCode) => void;
}

export type Handler<K extends EndpointKey> = (
  input: HandlerInput<K>,
) => ResultFor<Endpoint<K>> | Promise<ResultFor<Endpoint<K>>>;

/** Implementations by endpoint key. Endpoints without one answer 501 (after the auth check). */
export type Handlers = { [K in EndpointKey]?: Handler<K> };

type AnyHandler = (input: {
  c: Context<AppEnv>;
  ctx: AppContext;
  auth: AuthContext | null;
  params: unknown;
  query: unknown;
  body: unknown;
  setStatus: (status: ContentfulStatusCode) => void;
}) => unknown;

/** Static segments before `:params`, so `/api/memories/upcoming` wins over `/api/memories/:id`. */
export function compareRoutePaths(a: string, b: string): number {
  const left = a.split('/');
  const right = b.split('/');
  for (let i = 0; i < Math.min(left.length, right.length); i += 1) {
    const l = left[i]!;
    const r = right[i]!;
    const lParam = l.startsWith(':');
    const rParam = r.startsWith(':');
    if (lParam !== rParam) return lParam ? 1 : -1;
    if (l !== r) return l < r ? -1 : 1;
  }
  return left.length - right.length;
}

async function authorize(
  c: Context<AppEnv>,
  ctx: AppContext,
  key: string,
  spec: EndpointSpec,
): Promise<AuthContext | null> {
  const unsafe = spec.method !== 'GET';
  if (spec.auth === 'public' || spec.auth === 'signed') {
    if (unsafe && COOKIE_ISSUING_ENDPOINTS.has(key)) assertSameOrigin(c, ctx.env);
    return null;
  }
  const auth = await resolveAuth(c, ctx);
  if (!auth) throw new ApiError('unauthorized', 'Sign in to continue');
  if (unsafe && auth.kind === 'session') assertSameOrigin(c, ctx.env);
  if (spec.auth === 'device' && auth.kind !== 'device') {
    throw new ApiError('forbidden', 'This endpoint needs a device token');
  }
  if (spec.auth === 'admin' && auth.user.role !== 'admin') {
    throw new ApiError('forbidden', 'Only admins can do this');
  }
  return auth;
}

function parseInput<T extends z.ZodType>(
  schema: T,
  value: unknown,
  location: 'params' | 'query' | 'body',
): z.output<T> {
  const result = schema.safeParse(value);
  if (!result.success) throw validationError(result.error, location);
  return result.data;
}

async function readLimitedText(request: Request, limit: number): Promise<string> {
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (declared > limit) throw new ApiError('payload_too_large', 'The request body is too large');
  if (!request.body) return '';
  const reader = (request.body as ReadableStream<Uint8Array>).getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw new ApiError('payload_too_large', 'The request body is too large');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function readJsonBody(c: Context<AppEnv>): Promise<unknown> {
  const type = c.req.header('content-type') ?? '';
  if (!/^application\/([\w.+-]+\+)?json\b/i.test(type)) {
    throw new ApiError('unsupported_media_type', 'Send a JSON body with Content-Type: application/json');
  }
  const text = await readLimitedText(c.req.raw, MAX_JSON_BODY_BYTES);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ApiError('bad_request', 'The request body is not valid JSON');
  }
}

function defaultStatus(spec: EndpointSpec): StatusCode {
  return spec.successStatus ?? (spec.responseKind === 'empty' ? 204 : 200);
}

/** Registers every endpoint of the shared contract on the app. */
export function mountContract(app: Hono<AppEnv>, ctx: AppContext, handlers: Handlers): void {
  const entries = (Object.entries(endpoints) as [EndpointKey, EndpointSpec][]).sort(([, a], [, b]) =>
    compareRoutePaths(a.path, b.path),
  );

  for (const [key, spec] of entries) {
    const handler = handlers[key] as AnyHandler | undefined;
    app.on(spec.method, spec.path, async (c) => {
      const auth = await authorize(c, ctx, key, spec);
      if (!handler) {
        throw new ApiError('not_implemented', `${spec.method} ${spec.path} (${key}) is not implemented yet`);
      }

      const params = spec.params ? parseInput(spec.params, c.req.param(), 'params') : undefined;
      const query = spec.query ? parseInput(spec.query, c.req.query(), 'query') : undefined;
      const body =
        spec.body && spec.bodyKind !== 'multipart'
          ? parseInput(spec.body, await readJsonBody(c), 'body')
          : undefined;

      let status = defaultStatus(spec);
      const result = await handler({
        c,
        ctx,
        auth,
        params,
        query,
        body,
        setStatus: (next) => {
          status = next;
        },
      });
      if (result instanceof Response) return result;
      if (spec.responseKind === 'empty' || !spec.response) return c.body(null, status);

      // Parsing strips anything outside the contract, so a stray database column never leaks.
      const parsed = spec.response.safeParse(result);
      if (!parsed.success) {
        c.var.log.error({ endpoint: key, issues: parsed.error.issues }, 'Response does not match the contract');
        throw new ApiError('internal_error', 'The server produced an invalid response');
      }
      return c.json(parsed.data, status as ContentfulStatusCode);
    });
  }
}
