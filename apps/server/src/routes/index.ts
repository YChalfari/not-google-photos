import type { Handlers } from '../http/contract';
import { adminHandlers } from './admin';
import { authHandlers } from './auth';
import { deviceHandlers } from './devices';
import { inviteHandlers } from './invites';
import { mediaHandlers } from './media';
import { serverHandlers } from './server';

/**
 * Every implemented endpoint. Endpoints of the shared contract that are missing here answer 501
 * until the piece that owns them adds a handler (and a file in this folder).
 */
export const handlers: Handlers = {
  ...serverHandlers,
  ...authHandlers,
  ...inviteHandlers,
  ...adminHandlers,
  ...deviceHandlers,
  ...mediaHandlers,
};
