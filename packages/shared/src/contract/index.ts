import { adminEndpoints } from '../api/admin';
import { albumEndpoints } from '../api/albums';
import { assetEndpoints } from '../api/assets';
import { authEndpoints } from '../api/auth';
import { deviceEndpoints } from '../api/devices';
import { inviteEndpoints } from '../api/invites';
import { mediaEndpoints } from '../api/media';
import { memoryEndpoints } from '../api/memories';
import { peopleEndpoints } from '../api/people';
import { searchEndpoints } from '../api/search';
import { serverEndpoints } from '../api/server';
import { timelineEndpoints } from '../api/timeline';
import { userEndpoints } from '../api/users';
import type {
  BodyInput,
  EndpointSpec,
  ParamsInput,
  QueryInput,
  ResponseOutput,
} from './define';

/** Every HTTP endpoint of the server, keyed by a stable dotted name (the OpenAPI operationId). */
export const endpoints = {
  ...serverEndpoints,
  ...authEndpoints,
  ...inviteEndpoints,
  ...adminEndpoints,
  ...userEndpoints,
  ...deviceEndpoints,
  ...mediaEndpoints,
  ...assetEndpoints,
  ...timelineEndpoints,
  ...peopleEndpoints,
  ...searchEndpoints,
  ...albumEndpoints,
  ...memoryEndpoints,
} satisfies Record<string, EndpointSpec>;

export type Endpoints = typeof endpoints;
export type EndpointKey = keyof Endpoints;
export type Endpoint<K extends EndpointKey> = Endpoints[K];

/** What a client sends for an endpoint (zod input types). */
export interface RequestOf<K extends EndpointKey> {
  params: ParamsInput<Endpoint<K>>;
  query: QueryInput<Endpoint<K>>;
  body: BodyInput<Endpoint<K>>;
}

/** What a client receives on success (zod output types). */
export type ResponseOf<K extends EndpointKey> = ResponseOutput<Endpoint<K>>;

export const endpointKeys = Object.keys(endpoints) as EndpointKey[];

export * from './define';
