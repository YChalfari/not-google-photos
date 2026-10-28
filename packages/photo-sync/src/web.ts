import { WebPlugin } from '@capacitor/core';

import type {
  DiscoveredServer,
  FreeUpFilter,
  FreeableSummary,
  FreeUpResult,
  MediaFolder,
  PermissionStatus,
  PhotoSyncPlugin,
  DeviceConnection,
  SyncConfiguration,
  SyncStatus,
} from './definitions';

const ANDROID_ONLY = 'Backup runs in the Not Google Photos app on your phone.';

/**
 * Browser fallback. Browsers can't read the camera roll in the background, so status calls
 * resolve with `available: false` and everything that would touch the phone's library rejects
 * with Capacitor's "unavailable" error.
 */
export class PhotoSyncWeb extends WebPlugin implements PhotoSyncPlugin {
  async checkPermissions(): Promise<PermissionStatus> {
    return {
      media: 'denied',
      mediaLocation: 'denied',
      notifications: 'denied',
      batteryOptimizationExempt: true,
    };
  }

  async requestPermissions(): Promise<PermissionStatus> {
    return this.checkPermissions();
  }

  async configure(): Promise<void> {
    throw this.unavailable(ANDROID_ONLY);
  }

  async setSchedule(): Promise<void> {
    throw this.unavailable(ANDROID_ONLY);
  }

  async syncNow(): Promise<void> {
    throw this.unavailable(ANDROID_ONLY);
  }

  async getStatus(): Promise<SyncStatus> {
    return {
      platform: 'web',
      available: false,
      configured: false,
      enabled: false,
      phase: 'idle',
      waitingFor: null,
      counts: { backedUp: 0, pending: 0, uploading: 0, failed: 0, total: 0 },
      todayNotBackedUp: 0,
      current: null,
      lastRun: null,
      lastSuccessfulBackupAt: null,
      lastServerContactAt: null,
      firstBackup: { complete: false, remaining: 0 },
      nextRetryAt: null,
    };
  }

  async getFreeableSummary(_filter: FreeUpFilter): Promise<FreeableSummary> {
    throw this.unavailable(ANDROID_ONLY);
  }

  async freeUpSpace(_filter: FreeUpFilter): Promise<FreeUpResult> {
    throw this.unavailable(ANDROID_ONLY);
  }

  async scheduleMemoryNotifications(): Promise<void> {
    throw this.unavailable(ANDROID_ONLY);
  }

  async getSettings(): Promise<SyncConfiguration> {
    throw this.unavailable(ANDROID_ONLY);
  }

  async getConnection(): Promise<DeviceConnection | null> {
    return null;
  }

  async listFolders(): Promise<{ folders: MediaFolder[] }> {
    throw this.unavailable(ANDROID_ONLY);
  }

  async retryFailed(): Promise<void> {
    throw this.unavailable(ANDROID_ONLY);
  }

  async requestBatteryOptimizationExemption(): Promise<{ exempt: boolean }> {
    return { exempt: true };
  }

  async discoverServers(): Promise<{ servers: DiscoveredServer[] }> {
    throw this.unavailable(ANDROID_ONLY);
  }

  async scanQrCode(): Promise<{ value: string }> {
    throw this.unavailable(ANDROID_ONLY);
  }

  async pair(): Promise<{
    serverId: string | null;
    deviceId: string | null;
    userName: string | null;
  }> {
    throw this.unavailable(ANDROID_ONLY);
  }
}
