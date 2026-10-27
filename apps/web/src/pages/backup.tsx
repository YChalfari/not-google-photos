import { DEFAULT_TRIGGERS, PhotoSync, type MediaFolder, type SyncStatus } from '@ngp/photo-sync';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { FormError, LoadingBlock, Page } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { isNativeApp } from '@/lib/native';

const PHASE: Record<SyncStatus['phase'], string> = {
  idle: 'Idle',
  checkingServer: 'Checking the server',
  scanning: 'Scanning the camera roll',
  hashing: 'Hashing',
  checking: 'Checking what the server already has',
  uploading: 'Uploading',
};

const WAITING: Record<NonNullable<SyncStatus['waitingFor']>, string> = {
  setup: 'setup to finish',
  disabled: 'backup to be turned on',
  permission: 'photo access',
  pairing: 'this phone to be paired',
  network: 'a network connection',
  wifi: 'Wi-Fi',
  server: 'the server',
  charging: 'the phone to charge',
  firstBackup: 'the first backup',
  backoff: 'a retry',
};

function formatEpoch(ms: number | null): string {
  if (!ms) return 'Never';
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(
    new Date(ms),
  );
}

export function BackupPage() {
  if (!isNativeApp()) {
    return (
      <Page
        title="Backup"
        lede="The camera roll is backed up by the Android app. This browser can upload files you pick, and it can show a pairing code under Settings."
      />
    );
  }
  return <PhoneBackup />;
}

function PhoneBackup() {
  const queryClient = useQueryClient();
  const statusQuery = useQuery({
    queryKey: ['backup', 'status'],
    queryFn: () => PhotoSync.getStatus(),
  });
  const permissionsQuery = useQuery({
    queryKey: ['backup', 'permissions'],
    queryFn: () => PhotoSync.checkPermissions(),
  });
  const [folders, setFolders] = useState<MediaFolder[] | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const status = statusQuery.data ?? null;
  const permissions = permissionsQuery.data ?? null;

  useEffect(() => {
    let cancelled = false;
    const handles: Array<{ remove: () => Promise<void> }> = [];
    const keep = (handle: { remove: () => Promise<void> }) => {
      if (cancelled) void handle.remove();
      else handles.push(handle);
    };
    void PhotoSync.addListener('statusChanged', () => {
      void queryClient.invalidateQueries({ queryKey: ['backup', 'status'] });
    }).then(keep);
    void PhotoSync.addListener('progress', () => {
      void queryClient.invalidateQueries({ queryKey: ['backup', 'status'] });
    }).then(keep);
    return () => {
      cancelled = true;
      for (const handle of handles) void handle.remove();
    };
  }, [queryClient]);

  async function run(label: string, action: () => Promise<unknown>) {
    setBusy(label);
    setError(null);
    try {
      await action();
      await queryClient.invalidateQueries({ queryKey: ['backup'] });
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(null);
    }
  }

  async function loadFolders() {
    const [listed, config] = await Promise.all([PhotoSync.listFolders(), PhotoSync.getSettings()]);
    setFolders(listed.folders);
    setSelectedIds(config.settings.folders);
  }

  async function toggleFolder(folder: MediaFolder) {
    const selected = new Set(selectedIds);
    if (selected.has(folder.id)) {
      if (selected.size === 1) return;
      selected.delete(folder.id);
    } else {
      selected.add(folder.id);
    }
    const next = [...selected];
    await PhotoSync.configure({ folders: next });
    setSelectedIds(next);
    const listed = await PhotoSync.listFolders();
    setFolders(listed.folders);
  }

  const detail = status ? describe(status) : '';

  return (
    <Page
      title="Backup"
      lede="This phone keeps its own queue and uploads when the schedule says so, even if the app is closed."
    >
      <Card>
        <CardHeader className="flex-row items-center justify-between gap-3">
          <div>
            <CardTitle>Queue</CardTitle>
            <CardDescription>{detail || 'Checking the queue.'}</CardDescription>
          </div>
          <Button
            type="button"
            variant="outline"
            onClick={() => void queryClient.invalidateQueries({ queryKey: ['backup'] })}
          >
            Refresh
          </Button>
        </CardHeader>
        <CardContent>
          {status ? (
            <dl className="grid grid-cols-2 gap-4 text-sm sm:grid-cols-4">
              <Stat label="Backed up" value={status.counts.backedUp} />
              <Stat label="Pending" value={status.counts.pending} />
              <Stat label="Failed" value={status.counts.failed} />
              <Stat label="Today left" value={status.todayNotBackedUp} />
            </dl>
          ) : (
            <LoadingBlock label="Checking backup" />
          )}
          {status?.current ? (
            <p className="mt-4 text-sm text-muted-foreground">
              Uploading {status.current.fileName} ({status.current.index} of {status.current.of}).
            </p>
          ) : null}
          {status ? (
            <p className="mt-2 text-sm text-muted-foreground">
              Last success {formatEpoch(status.lastSuccessfulBackupAt)}. Last contact{' '}
              {formatEpoch(status.lastServerContactAt)}.
            </p>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Permissions</CardTitle>
          <CardDescription>
            {permissions
              ? `Photos: ${permissions.media}. Location in photos: ${permissions.mediaLocation}. Notifications: ${permissions.notifications}. Battery exemption: ${permissions.batteryOptimizationExempt ? 'yes' : 'no'}.`
              : 'Not checked yet.'}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          <Button
            type="button"
            disabled={busy !== null}
            onClick={() => void run('permissions', () => PhotoSync.requestPermissions())}
          >
            Allow photos and notifications
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={busy !== null}
            onClick={() =>
              void run('battery', () => PhotoSync.requestBatteryOptimizationExemption())
            }
          >
            Battery optimization
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Run</CardTitle>
          <CardDescription>
            New photos wait about a minute, then an hourly pass runs. The first full backup waits
            for Wi-Fi and charging.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              disabled={busy !== null}
              onClick={() => void run('sync', () => PhotoSync.syncNow())}
            >
              Back up now
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={busy !== null}
              onClick={() => void run('retry', () => PhotoSync.retryFailed())}
            >
              Retry failed
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={busy !== null}
              onClick={() =>
                void run('schedule', () =>
                  PhotoSync.setSchedule({
                    triggers: DEFAULT_TRIGGERS.map((trigger) => ({ ...trigger })),
                  }),
                )
              }
            >
              Use the default schedule
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={busy !== null}
              onClick={() => void run('folders', loadFolders)}
            >
              {folders ? 'Refresh folders' : 'Choose folders'}
            </Button>
          </div>
          {folders ? (
            <ul className="flex flex-col gap-2">
              {folders.map((folder) => (
                <li key={folder.id}>
                  <label className="flex items-center gap-3 text-sm">
                    <input
                      type="checkbox"
                      className="size-4 accent-primary"
                      checked={selectedIds.includes(folder.id)}
                      onChange={() => void run(`folder-${folder.id}`, () => toggleFolder(folder))}
                    />
                    <span className="min-w-0 flex-1">
                      {folder.name}{' '}
                      <span className="text-muted-foreground">
                        · {folder.id} · {folder.count}
                      </span>
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          ) : null}
          <p className="text-xs text-muted-foreground">
            A checked folder covers its subfolders. At least one folder stays selected.
          </p>
          <FormError error={error ?? statusQuery.error ?? permissionsQuery.error} />
        </CardContent>
      </Card>
    </Page>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-serif text-2xl">{value}</dd>
    </div>
  );
}

function describe(status: SyncStatus): string {
  const waiting = status.waitingFor ? `Waiting for ${WAITING[status.waitingFor]}. ` : '';
  const phase = PHASE[status.phase];
  const paired = status.configured ? 'Paired with a server.' : 'No server paired yet.';
  const first = status.firstBackup.complete
    ? ''
    : ` First backup still has ${status.firstBackup.remaining} older items.`;
  return `${phase}. ${waiting}${paired}${first}`;
}
