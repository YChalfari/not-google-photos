import type { Handlers } from '../http/contract';
import { adminHandlers } from './admin';
import { albumHandlers } from './albums';
import { assetHandlers } from './assets';
import { authHandlers } from './auth';
import { deviceHandlers } from './devices';
import { inviteHandlers } from './invites';
import { mapHandlers } from './map';
import { mediaHandlers } from './media';
import { memoryHandlers } from './memories';
import { peopleHandlers } from './people';
import { searchHandlers } from './search';
import { serverHandlers } from './server';
import { timelineHandlers } from './timeline';

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
  ...mapHandlers,
  ...assetHandlers,
  ...timelineHandlers,
  ...peopleHandlers,
  ...searchHandlers,
  ...albumHandlers,
  ...memoryHandlers,
};
