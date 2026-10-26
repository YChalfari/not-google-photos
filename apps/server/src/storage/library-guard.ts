import { constants } from 'node:fs';
import { access, readFile, rename, stat, statfs, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { LibraryState, LibraryStatus } from '@ngp/shared';
import { LibraryUnavailableError, type WriteGuard } from './provider';

export const LIBRARY_MARKER_FILE = '.ngp-library.json';

interface Marker {
  app: 'not-google-photos';
  serverId: string;
  createdAt: string;
}

export interface LibraryGuardOptions {
  dir: string;
  serverId: string;
  minFreeBytes: number;
  /** Whether this server has already claimed a library folder (stored in the database). */
  isInitialized: () => Promise<boolean>;
  markInitialized: () => Promise<void>;
  cacheMs?: number;
}

/**
 * Refuses writes when the library folder isn't the one this server set up, so an unplugged
 * external drive never turns into photos piling up on the internal disk.
 *
 * On first run the server claims the folder by writing a marker file with its server id. After
 * that, a missing marker means the drive is gone (or the path is wrong) and uploads stop until it
 * is back.
 */
export class LibraryGuard implements WriteGuard {
  private cached: { at: number; status: LibraryStatus } | undefined;
  private pending: Promise<LibraryStatus> | undefined;

  constructor(private readonly options: LibraryGuardOptions) {}

  get dir(): string {
    return this.options.dir;
  }

  async status(options: { fresh?: boolean } = {}): Promise<LibraryStatus> {
    const cacheMs = this.options.cacheMs ?? 5000;
    if (!options.fresh && this.cached && Date.now() - this.cached.at < cacheMs) {
      return this.cached.status;
    }
    this.pending ??= this.check().finally(() => {
      this.pending = undefined;
    });
    const status = await this.pending;
    this.cached = { at: Date.now(), status };
    return status;
  }

  async assertWritable(): Promise<void> {
    const status = await this.status();
    if (status.state !== 'ok') throw new LibraryUnavailableError(status);
  }

  private result(
    state: LibraryState,
    message: string,
    space: { freeBytes: number | null; totalBytes: number | null } = {
      freeBytes: null,
      totalBytes: null,
    },
  ): LibraryStatus {
    return { state, message, path: this.options.dir, ...space };
  }

  private async check(): Promise<LibraryStatus> {
    const { dir, serverId } = this.options;
    const isDir = await stat(dir).then(
      (info) => info.isDirectory(),
      () => false,
    );
    if (!isDir) {
      return this.result(
        'missing',
        `The library folder ${dir} isn't available. If it's on an external drive, connect the drive and restart the server.`,
      );
    }

    let marker = await this.readMarker();
    if (!marker) {
      if (await this.options.isInitialized()) {
        return this.result(
          'missing',
          `The library folder ${dir} has no library marker file. The drive may not be mounted, or LIBRARY_DIR points at the wrong folder.`,
        );
      }
      try {
        marker = await this.writeMarker();
        await this.options.markInitialized();
      } catch (error) {
        return this.result(
          'not_writable',
          `Can't write to the library folder ${dir}: ${(error as Error).message}`,
        );
      }
    }

    if (marker.serverId !== serverId) {
      return this.result(
        'mismatch',
        `The library folder ${dir} belongs to another server (${marker.serverId}). Point LIBRARY_DIR at this server's library.`,
      );
    }
    if (!(await this.options.isInitialized())) await this.options.markInitialized();

    try {
      await access(dir, constants.W_OK);
    } catch {
      return this.result('not_writable', `The library folder ${dir} is read-only.`);
    }

    const space = await statfs(dir).then(
      (fs) => ({ freeBytes: fs.bavail * fs.bsize, totalBytes: fs.blocks * fs.bsize }),
      () => ({ freeBytes: null, totalBytes: null }),
    );
    if (space.freeBytes !== null && space.freeBytes < this.options.minFreeBytes) {
      return this.result(
        'low_space',
        `The library drive is almost full (${formatGb(space.freeBytes)} free). Uploads are paused until there is at least ${formatGb(this.options.minFreeBytes)}.`,
        space,
      );
    }
    return this.result('ok', 'The library folder is connected and writable.', space);
  }

  private async readMarker(): Promise<Marker | null> {
    try {
      const raw = await readFile(path.join(this.options.dir, LIBRARY_MARKER_FILE), 'utf8');
      const parsed = JSON.parse(raw) as Partial<Marker>;
      return typeof parsed.serverId === 'string' ? (parsed as Marker) : null;
    } catch {
      return null;
    }
  }

  private async writeMarker(): Promise<Marker> {
    const marker: Marker = {
      app: 'not-google-photos',
      serverId: this.options.serverId,
      createdAt: new Date().toISOString(),
    };
    const target = path.join(this.options.dir, LIBRARY_MARKER_FILE);
    const tmp = `${target}.tmp`;
    await writeFile(tmp, `${JSON.stringify(marker, null, 2)}\n`, { flag: 'w' });
    await rename(tmp, target);
    return marker;
  }
}

function formatGb(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}
