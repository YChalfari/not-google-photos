import {
  SESSION_COOKIE,
  buildPath,
  endpoints,
  type ApiErrorBody,
  type EndpointKey,
  type RequestOf,
  type ResponseOf,
} from '@ngp/shared';
import type { Hono } from 'hono';
import type { AppEnv } from '../../src/http/types';

/** In-process requests use this origin; writes send it as `Origin` like a browser would. */
export const TEST_ORIGIN = 'http://ngp.test';

export interface CallInput<K extends EndpointKey> {
  params?: RequestOf<K>['params'];
  query?: RequestOf<K>['query'];
  body?: RequestOf<K>['body'];
  headers?: Record<string, string>;
}

export interface CallResult<K extends EndpointKey> {
  status: number;
  res: Response;
  /** The JSON body; only meaningful for 2xx responses. */
  data: ResponseOf<K>;
  error: ApiErrorBody['error'] | undefined;
}

/** A browser (session cookie) or phone (bearer token) talking to the app through the contract. */
export class TestClient {
  cookie: string | undefined;

  constructor(
    readonly app: Hono<AppEnv>,
    readonly token?: string,
  ) {}

  withToken(token: string): TestClient {
    return new TestClient(this.app, token);
  }

  async fetch(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    if (this.cookie && !headers.has('cookie'))
      headers.set('cookie', `${SESSION_COOKIE}=${this.cookie}`);
    if (this.token && !headers.has('authorization'))
      headers.set('authorization', `Bearer ${this.token}`);
    const method = init.method ?? 'GET';
    if (method !== 'GET' && method !== 'HEAD' && !headers.has('origin'))
      headers.set('origin', TEST_ORIGIN);
    const res = await this.app.request(`${TEST_ORIGIN}${path}`, { ...init, headers });
    for (const header of res.headers.getSetCookie()) {
      const [pair = ''] = header.split(';');
      const index = pair.indexOf('=');
      if (pair.slice(0, index) === SESSION_COOKIE) this.cookie = pair.slice(index + 1) || undefined;
    }
    return res;
  }

  async call<K extends EndpointKey>(key: K, input: CallInput<K> = {}): Promise<CallResult<K>> {
    const spec = endpoints[key];
    let path = buildPath(spec.path, input.params);
    if (input.query) {
      const search = new URLSearchParams();
      for (const [name, value] of Object.entries(input.query)) {
        if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
          search.set(name, String(value));
        }
      }
      path += `?${search.toString()}`;
    }
    const headers: Record<string, string> = { ...input.headers };
    if (input.body !== undefined) headers['content-type'] ??= 'application/json';
    const res = await this.fetch(path, {
      method: spec.method,
      headers,
      body: input.body === undefined ? undefined : JSON.stringify(input.body),
    });
    const text = await res.text();
    const json: unknown =
      text && res.headers.get('content-type')?.includes('application/json')
        ? JSON.parse(text)
        : undefined;
    return {
      status: res.status,
      res,
      data: json as ResponseOf<K>,
      error: (json as ApiErrorBody | undefined)?.error,
    };
  }
}
