import {
  buildPath,
  endpoints,
  type EndpointKey,
  type RequestOf,
  type ResponseOf,
} from '@ngp/shared';

export class ApiClientError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiClientError';
  }
}

export function errorMessage(
  error: unknown,
  fallback = 'Something went wrong. Try again.',
): string {
  if (error instanceof ApiClientError) return error.message;
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}

type CallInput<K extends EndpointKey> = {
  params?: RequestOf<K>['params'];
  query?: RequestOf<K>['query'];
  body?: RequestOf<K>['body'];
};

/** Calls one endpoint of the shared contract. The session cookie rides along. */
export async function api<K extends EndpointKey>(
  key: K,
  input: CallInput<K> = {},
  init: { signal?: AbortSignal } = {},
): Promise<ResponseOf<K>> {
  const spec = endpoints[key];
  let path = buildPath(spec.path, input.params);
  if (input.query) {
    const search = new URLSearchParams();
    for (const [name, value] of Object.entries(input.query)) {
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        search.set(name, String(value));
      }
    }
    const qs = search.toString();
    if (qs) path += `?${qs}`;
  }

  const headers = new Headers();
  if (input.body !== undefined) headers.set('content-type', 'application/json');
  const response = await fetch(path, {
    method: spec.method,
    headers,
    body: input.body === undefined ? undefined : JSON.stringify(input.body),
    credentials: 'include',
    signal: init.signal,
  });

  if (response.status === 204) {
    if (!response.ok) throw await readError(response);
    return undefined as ResponseOf<K>;
  }

  const json = (await response.json().catch(() => undefined)) as
    { error?: { code?: string; message?: string; details?: unknown } } | undefined;
  if (!response.ok) {
    throw new ApiClientError(
      response.status,
      json?.error?.code ?? 'internal_error',
      json?.error?.message ?? `Request failed (${response.status})`,
      json?.error?.details,
    );
  }
  return json as ResponseOf<K>;
}

async function readError(response: Response): Promise<ApiClientError> {
  const json = (await response.json().catch(() => undefined)) as
    { error?: { code?: string; message?: string; details?: unknown } } | undefined;
  return new ApiClientError(
    response.status,
    json?.error?.code ?? 'internal_error',
    json?.error?.message ?? `Request failed (${response.status})`,
    json?.error?.details,
  );
}
