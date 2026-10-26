import type { HttpBindings } from '@hono/node-server';
import type { AuthContext } from './auth';
import type { Logger } from '../logger';

export interface AppVariables {
  requestId: string;
  log: Logger;
  /** Resolved lazily by `resolveAuth`; `null` once checked and anonymous. */
  auth?: AuthContext | null;
}

export interface AppEnv {
  Bindings: HttpBindings;
  Variables: AppVariables;
}
