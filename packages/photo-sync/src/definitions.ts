import type { PluginListenerHandle } from '@capacitor/core';

/**
 * The PhotoSync contract shared by every platform (A1 in the build plan).
 *
 * Android implements it in Kotlin today; an iOS Swift implementation must expose the same
 * methods, types, and events so the web UI never needs platform checks beyond `available`.
 */
export interface PhotoSyncPlugin {
  /** Current permission state without prompting. */
  checkPermissions(): Promise<PermissionStatus>;

  /**
   * Prompts for photo and video access (including original location on Android) and for
   * notifications. Resolves with the resulting state; never rejects because of a denial.
   */
  requestPermissions(): Promise<PermissionStatus>;

  /**
   * Saves backup settings and re-arms every schedule. Fields you omit keep their current value,
   * so the Backup screen can send only what changed. The first call with a server and a device
   * token also indexes the camera roll and queues the first full backup.
   */
  configure(settings: SyncSettings): Promise<void>;

  /** Replaces the automatic triggers. Manual backups (`syncNow`) and the daily safety net always stay on. */
  setSchedule(schedule: { triggers: SyncTrigger[] }): Promise<void>;

  /** "Back up now": starts a run immediately, skipping any slow backoff that is in effect. */
  syncNow(): Promise<void>;

  /** A snapshot of the queue and the engine. */
  getStatus(): Promise<SyncStatus>;

  /**
   * Media still on the phone that the server has just confirmed, with the space deleting it would free.
   * Asks the server before counting, and rejects when the server cannot be checked.
   */
  getFreeableSummary(filter: FreeUpFilter): Promise<FreeableSummary>;

  /**
   * Permanently deletes confirmed media from the phone after the server re-verifies each file.
   * Android then shows its own allow-delete dialog. Nothing is removed from the library.
   */
  freeUpSpace(filter: FreeUpFilter): Promise<FreeUpResult>;

  /**
   * Schedules local notifications for the server's upcoming memories at `time` (24-hour "HH:mm",
   * default "09:00"). Upcoming memories are refreshed after every successful backup run.
   * Pass `enabled: false` to cancel them.
   */
  scheduleMemoryNotifications(opts: { time: string; enabled?: boolean }): Promise<void>;

  /** Fires while a run is working (throttled to a few events per second). */
  addListener(
    eventName: 'progress',
    listenerFunc: (status: SyncStatus) => void,
  ): Promise<PluginListenerHandle>;

  /** Fires when the phase, counts, outcome, or waiting reason change. */
  addListener(
    eventName: 'statusChanged',
    listenerFunc: (status: SyncStatus) => void,
  ): Promise<PluginListenerHandle>;

  removeAllListeners(): Promise<void>;

  // App-shell additions. These are not in the original A1 sketch but every platform needs them
  // for the Backup screen and the first-run "Connect to your server" flow.

  /** The stored settings (without the device token) and the active triggers. */
  getSettings(): Promise<SyncConfiguration>;

  /**
   * The server the bundled UI should call, plus the device token for `Authorization`.
   * Resolves to null when this phone is not paired. Home is preferred on Wi-Fi and the away
   * address is preferred off it, using the same lookup as a backup run. A Bonjour find can
   * update the stored home address when the computer's IP changed. When the phone is paired
   * but nothing answers, the stored address is still returned so the UI can show that the
   * server is unreachable. The token is kept out of `getSettings`.
   */
  getConnection(): Promise<DeviceConnection | null>;

  /** Folders that contain photos or videos, for the folder picker. */
  listFolders(): Promise<{ folders: MediaFolder[] }>;

  /** Puts failed items back in the queue and starts a run. */
  retryFailed(): Promise<void>;

  /**
   * Android: opens the system prompt that exempts the app from battery optimization, which some
   * phone makers require for background work to run at all. Resolves with the resulting state.
   */
  requestBatteryOptimizationExemption(): Promise<{ exempt: boolean }>;

  /** Looks for Not Google Photos servers announced on the local network (Bonjour / DNS-SD). */
  discoverServers(opts?: { timeoutMs?: number }): Promise<{ servers: DiscoveredServer[] }>;

  /** Opens the system QR scanner and resolves with the raw text of the first QR code it reads. */
  scanQrCode(): Promise<{ value: string }>;

  /**
   * Redeems a one-time pairing code (`POST /api/devices/pair`) and stores the device token.
   * Pass the addresses from the QR code; omitted addresses keep their stored values.
   * The QR payload itself is JSON: `{ serverId, homeUrl, remoteUrl?, code }`.
   */
  pair(opts: {
    code: string;
    homeUrl?: string;
    remoteUrl?: string | null;
    serverId?: string | null;
    deviceName?: string;
  }): Promise<{ serverId: string | null; deviceId: string | null; userName: string | null }>;
}

export type PermissionState = 'prompt' | 'prompt-with-rationale' | 'granted' | 'denied';

export interface PermissionStatus {
  /**
   * Photo and video library access. `limited` means the person chose "selected photos only"
   * (Android 14+), so backup only sees the items they picked.
   */
  media: PermissionState | 'limited';
  /**
   * Access to the original location in photos (Android `ACCESS_MEDIA_LOCATION`). Without it Android
   * strips GPS from every file the app reads, so backups would have no location.
   */
  mediaLocation: PermissionState;
  notifications: PermissionState;
  /** True when the app is exempt from battery optimization (always true where the concept doesn't exist). */
  batteryOptimizationExempt: boolean;
}

/**
 * A folder id is a path relative to the storage root with a trailing slash, for example
 * `DCIM/Camera/` or `Pictures/Screenshots/`. Selecting a folder also selects its subfolders,
 * so `DCIM/` covers every camera folder.
 */
export type FolderId = string;

export interface SyncSettings {
  /** Automatic backup on or off. Default true. */
  enabled?: boolean;
  /** Home network address, for example `http://192.168.1.20:8080`. Plain HTTP is accepted only for private-network hosts. */
  homeUrl?: string;
  /** Optional away-from-home address (Tailscale or your own domain). Must be HTTPS. `null` removes it. */
  remoteUrl?: string | null;
  /**
   * The server id from the pairing QR code. Lets the phone find the server again on the home
   * network after the Mac's IP address changes.
   */
  serverId?: string | null;
  /** Device token from `POST /api/devices/pair`. Stored encrypted; never returned by `getSettings`. */
  deviceToken?: string;
  /** Folders to back up. Default `["DCIM/"]`. */
  folders?: FolderId[];
  /** Back up videos as well as photos. Default true. */
  includeVideos?: boolean;
  /**
   * Still photos outside the camera folders upload into the holding area.
   * Screenshots and camera document scans are reviewed even when this is off.
   * Default true.
   */
  includeOtherPhotos?: boolean;
  /** Only back up on Wi-Fi (unmetered networks). Default true. */
  wifiOnly?: boolean;
  /**
   * Wait until the phone is plugged in before the first full backup and before videos.
   * Default false. Photos upload on Wi-Fi without a charger unless this is on.
   */
  requireCharging?: boolean;
  /** Only upload videos while the phone is charging. Default true. Ignored when `requireCharging` is false. */
  videosOnlyWhileCharging?: boolean;
  /** End-of-day reminder time, 24-hour "HH:mm". Default "21:00". `null` turns the reminder off. */
  reminderTime?: string | null;
  /** Extra reminder when the server hasn't been reachable for this many days. Default 3. 0 turns it off. */
  unreachableNudgeDays?: number;
}

/** Settings as stored on the device. */
export interface StoredSyncSettings {
  enabled: boolean;
  homeUrl: string | null;
  remoteUrl: string | null;
  serverId: string | null;
  /** True when a device token is stored. */
  paired: boolean;
  folders: FolderId[];
  includeVideos: boolean;
  /** Still photos outside the camera folders go to the holding area. */
  includeOtherPhotos: boolean;
  wifiOnly: boolean;
  requireCharging: boolean;
  videosOnlyWhileCharging: boolean;
  reminderTime: string | null;
  unreachableNudgeDays: number;
}

/** What the bundled UI needs to call the server. Not available in a browser. */
export interface DeviceConnection {
  /** Origin that answered, or the stored address when the phone is paired but nothing answered. */
  baseUrl: string;
  /** Device token. Held in memory by the API client; never written to `localStorage`. */
  token: string;
  serverId: string | null;
}

export interface SyncConfiguration {
  settings: StoredSyncSettings;
  triggers: SyncTrigger[];
  /** Memory notification time ("HH:mm"), or null when memory notifications are off. */
  memoryNotificationTime: string | null;
}

/**
 * When automatic backups run. The defaults are a new-media trigger with a 60-second debounce and
 * a 10-minute cap, plus an hourly interval.
 */
export type SyncTrigger =
  /**
   * Runs after new photos or videos appear. Each new item restarts the `debounceSec` wait, so a
   * burst becomes one run; `maxDelayMin` caps the wait during long bursts.
   */
  | { kind: 'onNewMedia'; debounceSec: number; maxDelayMin: number }
  /** Runs every `everyMin` minutes (Android's minimum is 15). */
  | { kind: 'interval'; everyMin: number }
  /** Runs at each listed time of day, 24-hour "HH:mm". */
  | { kind: 'timesOfDay'; times: string[] };

export type SyncPhase =
  'idle' | 'checkingServer' | 'scanning' | 'hashing' | 'checking' | 'uploading';

/** Why items are waiting instead of uploading. */
export type WaitingReason =
  | 'setup'
  | 'disabled'
  | 'permission'
  | 'pairing'
  | 'network'
  | 'wifi'
  | 'server'
  | 'charging'
  | 'firstBackup'
  | 'backoff';

export type RunOutcome =
  | 'completed'
  | 'nothingToDo'
  | 'notConfigured'
  | 'disabled'
  | 'noPermission'
  | 'waitingForNetwork'
  | 'waitingForWifi'
  | 'waitingForCharging'
  | 'serverUnreachable'
  | 'needsPairing'
  | 'uploadFailed'
  | 'backingOff'
  | 'interrupted'
  | 'error';

export type RunTrigger =
  | 'onNewMedia'
  | 'interval'
  | 'timesOfDay'
  | 'manual'
  | 'reconcile'
  | 'firstBackup'
  | 'wifi'
  | 'network'
  | 'charging'
  | 'backoff'
  | 'reminder'
  | 'settings';

export interface SyncRun {
  trigger: RunTrigger;
  startedAt: number;
  finishedAt: number | null;
  outcome: RunOutcome | null;
  uploaded: number;
  failed: number;
  message: string | null;
}

export interface CurrentUpload {
  fileName: string;
  bytesSent: number;
  bytesTotal: number;
  /** 1-based position of this file within the current run. */
  index: number;
  /** Number of files this run is uploading. */
  of: number;
}

export interface SyncStatus {
  platform: 'android' | 'ios' | 'web';
  /** False where background backup isn't possible (the browser). */
  available: boolean;
  /** True once a server address and a device token are stored. */
  configured: boolean;
  enabled: boolean;
  phase: SyncPhase;
  /** Set when there is something to back up but it can't go right now. */
  waitingFor: WaitingReason | null;
  counts: {
    backedUp: number;
    pending: number;
    uploading: number;
    failed: number;
    total: number;
  };
  /** Photos and videos captured today that aren't backed up yet. */
  todayNotBackedUp: number;
  /** The file being uploaded right now, or null. */
  current: CurrentUpload | null;
  lastRun: SyncRun | null;
  /** Epoch ms of the last run that finished with everything eligible backed up. */
  lastSuccessfulBackupAt: number | null;
  /** Epoch ms of the last time the server answered. */
  lastServerContactAt: number | null;
  firstBackup: {
    complete: boolean;
    /** Items from before setup still waiting for the first full backup. */
    remaining: number;
  };
  /** Epoch ms when items that failed mid-upload will be tried again, or null. */
  nextRetryAt: number | null;
}

export interface MediaFolder {
  id: FolderId;
  /** Display name, for example "Camera" or "WhatsApp Images". */
  name: string;
  /** Number of photos and videos in the folder (not counting subfolders). */
  count: number;
  /** Whether the folder is covered by the current selection. */
  selected: boolean;
}

export interface DiscoveredServer {
  /** The announced service name, usually the Mac's name. */
  name: string;
  /** Server id from the announcement's TXT record, if present. */
  serverId: string | null;
  /** Base URL to use as `homeUrl`. */
  url: string;
  host: string;
  port: number;
}

export interface FreeUpFilter {
  /**
   * Only include items captured at least this many days ago.
   * Omit it, or pass 0, to include every backed-up item, including today's.
   */
  olderThanDays?: number;
  /** Keep items marked as favorites on the phone. Default true. */
  keepFavorites?: boolean;
  mediaType?: 'all' | 'photos' | 'videos';
  /** Limit to these folders. Omit to include every backed-up item still on the phone. */
  folders?: FolderId[];
}

export interface FreeableSummary {
  count: number;
  bytes: number;
  photos: number;
  videos: number;
}

export interface FreeUpResult {
  /** Items permanently deleted from the phone. */
  deleted: number;
  bytesFreed: number;
  /** Items left on the phone because the server could not confirm them. */
  skippedUnverified: number;
  /** True when the person declined Android's confirmation. Batches already allowed stay deleted. */
  cancelled: boolean;
}
