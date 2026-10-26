import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { serveStatic } from '@hono/node-server/serve-static';
import type { ApiErrorCode } from '@ngp/shared';
import { buildOpenApiDocument } from '@ngp/shared/openapi';
import { Hono, type Context } from 'hono';
import { cors } from 'hono/cors';
import { HTTPException } from 'hono/http-exception';
import { secureHeaders } from 'hono/secure-headers';
import type { AppContext } from './context';
import type { Env } from './env';
import { mountContract, type Handlers } from './http/contract';
import { ApiError, sendError, toApiError } from './http/errors';
import type { AppEnv } from './http/types';
import { handlers as defaultHandlers } from './routes';

/** Origins of the phone app's WebView (Capacitor on Android and iOS). */
const APP_ORIGINS = new Set(['http://localhost', 'https://localhost', 'capacitor://localhost']);

const WEB_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

export function isAllowedCorsOrigin(origin: string, env: Pick<Env, 'NODE_ENV' | 'CORS_ORIGINS'>): boolean {
  if (APP_ORIGINS.has(origin) || env.CORS_ORIGINS.includes(origin)) return true;
  // A web dev server on another port, pointed at this server.
  return env.NODE_ENV === 'development' && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
}

function codeForStatus(status: number): ApiErrorCode {
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 413) return 'payload_too_large';
  if (status === 415) return 'unsupported_media_type';
  if (status === 429) return 'rate_limited';
  return status < 500 ? 'bad_request' : 'internal_error';
}

function mountWebApp(app: Hono<AppEnv>, root: string): void {
  let indexHtml: Promise<string> | undefined;
  const sendIndex = async (c: Context<AppEnv>) => {
    indexHtml ??= readFile(path.join(root, 'index.html'), 'utf8');
    return c.html(await indexHtml, 200, {
      'Cache-Control': 'no-cache',
      'Content-Security-Policy': WEB_CSP,
    });
  };

  app.get('/', sendIndex);
  app.get('/index.html', sendIndex);
  app.use('/assets/*', async (c, next) => {
    await next();
    if (c.res.status === 200) c.header('Cache-Control', 'public, max-age=31536000, immutable');
  });
  app.use('*', serveStatic({ root }));
  // Client-side routes (`/settings`, `/invite/…`) get the app; missing files get a 404.
  app.get('*', async (c) => (path.extname(c.req.path) ? c.text('Not found', 404) : sendIndex(c)));
}

export function createApp(ctx: AppContext, options: { handlers?: Handlers } = {}): Hono<AppEnv> {
  const handlers = options.handlers ?? defaultHandlers;
  const app = new Hono<AppEnv>();

  app.use('*', async (c, next) => {
    const requestId = c.req.header('x-request-id')?.slice(0, 100) || randomUUID();
    c.set('requestId', requestId);
    c.set('log', ctx.log.child({ reqId: requestId }));
    const started = performance.now();
    await next();
    c.header('X-Request-Id', requestId);
    const { path: requestPath } = c.req;
    const quiet =
      !requestPath.startsWith('/api/') ||
      requestPath === '/api/ping' ||
      requestPath === '/api/health' ||
      requestPath.startsWith('/api/media/');
    const status = c.res.status;
    const level = status >= 500 ? 'error' : quiet ? 'debug' : 'info';
    c.var.log[level](
      { method: c.req.method, path: requestPath, status, ms: Math.round(performance.now() - started) },
      'request',
    );
  });

  app.use(
    '*',
    secureHeaders({
      // The phone app loads media from its own origin, so resources must be embeddable cross-origin.
      crossOriginResourcePolicy: 'cross-origin',
      // Plain HTTP on the home network; a TLS proxy (Tailscale, Cloudflare) sets HSTS itself.
      strictTransportSecurity: false,
      xFrameOptions: 'DENY',
    }),
  );

  app.use(
    '/api/*',
    cors({
      origin: (origin) => (isAllowedCorsOrigin(origin, ctx.env) ? origin : null),
      allowMethods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowHeaders: ['Authorization', 'Content-Type', 'Range', 'If-None-Match', 'X-Request-Id'],
      exposeHeaders: ['Content-Length', 'Content-Range', 'ETag', 'Retry-After', 'X-Request-Id'],
      maxAge: 600,
    }),
  );

  mountContract(app, ctx, handlers);

  let openapi: Record<string, unknown> | undefined;
  app.get('/api/openapi.json', (c) => {
    openapi ??= buildOpenApiDocument({
      version: ctx.version,
      implemented: new Set(Object.keys(handlers)),
    });
    return c.json(openapi);
  });

  app.all('/api/*', (c) =>
    sendError(c, new ApiError('not_found', `No API endpoint at ${c.req.method} ${c.req.path}`)),
  );

  if (ctx.env.WEB_DIST_DIR) mountWebApp(app, ctx.env.WEB_DIST_DIR);

  app.notFound((c) => c.text('Not found', 404));

  app.onError((error, c) => {
    const log = c.get('log') ?? ctx.log;
    const apiError = toApiError(error);
    if (apiError) {
      if (apiError.code === 'internal_error') log.error({ err: error }, 'Request failed');
      return sendError(c, apiError);
    }
    if (error instanceof HTTPException) {
      return sendError(c, new ApiError(codeForStatus(error.status), error.message, { status: error.status }));
    }
    log.error({ err: error }, 'Unhandled error');
    return sendError(c, new ApiError('internal_error', 'Something went wrong on the server'));
  });

  return app;
}
