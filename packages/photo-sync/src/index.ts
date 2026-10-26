import { registerPlugin } from '@capacitor/core';

import type { PhotoSyncPlugin } from './definitions';

const PhotoSync = registerPlugin<PhotoSyncPlugin>('PhotoSync', {
  web: () => import('./web').then((m) => new m.PhotoSyncWeb()),
});

/** Default schedule: debounced new-media trigger (1 minute, capped at 10) plus an hourly interval. */
export const DEFAULT_TRIGGERS = [
  { kind: 'onNewMedia', debounceSec: 60, maxDelayMin: 10 },
  { kind: 'interval', everyMin: 60 },
] as const;

/** Deep links that notification taps open. The path after `ngphotos://app` is the web route. */
export const DEEP_LINK_PREFIX = 'ngphotos://app';

export * from './definitions';
export { PhotoSync };
