import { z } from 'zod';
import { endpoints, type EndpointKey } from './contract';
import type { AuthPolicy, EndpointSpec } from './contract/define';
import { ApiErrorBody, DEFAULT_ERROR_STATUS } from './errors';
import { SESSION_COOKIE } from './constants';

export interface OpenApiOptions {
  version: string;
  /** Endpoint keys the server implements; the rest are marked as returning 501 for now. */
  implemented?: ReadonlySet<string>;
}

type JsonObject = Record<string, unknown>;

const SECURITY: Record<AuthPolicy, JsonObject[] | undefined> = {
  public: [],
  user: [{ sessionCookie: [] }, { deviceToken: [] }],
  admin: [{ sessionCookie: [] }, { deviceToken: [] }],
  device: [{ deviceToken: [] }],
  signed: [],
};

function rewriteRefs(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(rewriteRefs);
  if (value && typeof value === 'object') {
    const out: JsonObject = {};
    for (const [key, child] of Object.entries(value)) {
      if (key === '$schema') continue;
      out[key] =
        key === '$ref' && typeof child === 'string'
          ? child.replace('#/$defs/', '#/components/schemas/')
          : rewriteRefs(child);
    }
    return out;
  }
  return value;
}

function toOpenApiPath(path: string): string {
  return path.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
}

/** Builds an OpenAPI 3.1 document from the shared contract. */
export function buildOpenApiDocument(options: OpenApiOptions): JsonObject {
  const schemas: Record<string, unknown> = {};

  const convert = (schema: z.ZodType, io: 'input' | 'output'): JsonObject => {
    const json = z.toJSONSchema(schema, {
      io,
      target: 'draft-2020-12',
      unrepresentable: 'any',
    }) as JsonObject;
    const defs = (json.$defs ?? {}) as Record<string, unknown>;
    delete json.$defs;
    for (const [name, def] of Object.entries(defs)) schemas[name] ??= rewriteRefs(def);
    return rewriteRefs(json) as JsonObject;
  };

  const errorSchema = convert(ApiErrorBody, 'output');
  const paths: Record<string, Record<string, unknown>> = {};

  for (const [key, spec] of Object.entries(endpoints) as [EndpointKey, EndpointSpec][]) {
    const implemented = options.implemented?.has(key) ?? true;
    const parameters: JsonObject[] = [];
    for (const [location, schema] of [
      ['path', spec.params],
      ['query', spec.query],
    ] as const) {
      if (!schema) continue;
      const json = convert(schema, 'input');
      const required = new Set((json.required as string[] | undefined) ?? []);
      for (const [name, propertySchema] of Object.entries(
        (json.properties ?? {}) as Record<string, unknown>,
      )) {
        parameters.push({
          name,
          in: location,
          required: location === 'path' || required.has(name),
          schema: propertySchema,
        });
      }
    }

    let requestBody: JsonObject | undefined;
    if (spec.body) {
      const bodySchema = convert(spec.body, 'input');
      requestBody =
        spec.bodyKind === 'multipart'
          ? {
              required: true,
              content: {
                'multipart/form-data': {
                  schema: {
                    allOf: [
                      bodySchema,
                      {
                        type: 'object',
                        properties: { file: { type: 'string', contentMediaType: 'application/octet-stream' } },
                        required: ['file'],
                      },
                    ],
                  },
                },
              },
            }
          : { required: true, content: { 'application/json': { schema: bodySchema } } };
    }

    const successStatus = String(spec.successStatus ?? (spec.responseKind === 'empty' ? 204 : 200));
    const success: JsonObject =
      spec.responseKind === 'binary'
        ? { description: 'Media bytes', content: { 'application/octet-stream': {} } }
        : spec.responseKind === 'empty' || !spec.response
          ? { description: 'No content' }
          : {
              description: 'OK',
              content: { 'application/json': { schema: convert(spec.response, 'output') } },
            };

    const responses: Record<string, unknown> = { [successStatus]: success };
    for (const code of spec.errors ?? []) {
      const status = String(DEFAULT_ERROR_STATUS[code]);
      responses[status] ??= {
        description: code,
        content: { 'application/json': { schema: errorSchema } },
      };
    }
    responses.default = {
      description: 'Error',
      content: { 'application/json': { schema: errorSchema } },
    };
    if (!implemented) {
      responses['501'] = {
        description: 'Not implemented yet',
        content: { 'application/json': { schema: errorSchema } },
      };
    }

    const descriptionParts = [spec.description, implemented ? undefined : '**Not implemented yet: returns 501.**'];
    paths[toOpenApiPath(spec.path)] ??= {};
    paths[toOpenApiPath(spec.path)]![spec.method.toLowerCase()] = {
      operationId: key,
      tags: [spec.tag],
      summary: spec.summary,
      description: descriptionParts.filter(Boolean).join('\n\n') || undefined,
      security: SECURITY[spec.auth],
      parameters: parameters.length ? parameters : undefined,
      requestBody,
      responses,
      'x-auth': spec.auth,
      'x-stability': spec.stability,
      'x-implemented': implemented,
    };
  }

  return {
    openapi: '3.1.0',
    info: {
      title: 'Not Google Photos API',
      version: options.version,
      description:
        'Self-hosted photo library API. Browsers use the session cookie; phones use `Authorization: Bearer <device token>`; ' +
        'media loads through signed URLs.',
    },
    servers: [{ url: '/' }],
    paths,
    components: {
      schemas,
      securitySchemes: {
        sessionCookie: { type: 'apiKey', in: 'cookie', name: SESSION_COOKIE },
        deviceToken: { type: 'http', scheme: 'bearer', description: 'Device token from POST /api/devices/pair' },
      },
    },
  };
}
