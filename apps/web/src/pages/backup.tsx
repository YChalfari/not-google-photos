import { DEFAULT_TRIGGERS, PhotoSync, type MediaFolder, type SyncStatus } from '@ngp/photo-sync';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { DeleteBackedUpCard } from '@/components/delete-backed-up';
import { FormError, LoadingBlock, Page } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { isNativeApp } from '@/lib/native';
import { ReviewWaitingLink } from '@/pages/review';

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
      <Page title="Backup" lede="Backup runs on the phone. Pair one from Settings.">
        <ReviewWaitingLink />
      </Page>
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
  const settingsQuery = useQuery({
    queryKey: ['backup', 'settings'],
    queryFn: () => PhotoSync.getSettings(),
  });
  const permissionsQuery = useQuery({
    queryKey: ['backup', 'permissions'],
    queryFn: () => PhotoSync.checkPermissions(),
  });
  const [folders, setFolders] = useState<MediaFolder[] | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const startedBackup = useRef(false);
  const status = statusQuery.data ?? null;
  const permissions = permissionsQuery.data ?? null;
  const requireCharging = settingsQuery.data?.settings.requireCharging ?? true;
  const includeOtherPhotos = settingsQuery.data?.settings.includeOtherPhotos ?? true;

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
    setNotice(null);
    const started = Date.now();
    try {
      await action();
      await queryClient.invalidateQueries({ queryKey: ['backup'] });
      setNotice(ACTION_NOTE[label] ?? null);
    } catch (caught) {
      setError(caught);
    } finally {
      const remaining = 500 - (Date.now() - started);
      if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
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

  const detail = status ? describe(status, requireCharging) : '';
  const readyToRun =
    status?.configured === true &&
    status.enabled &&
    status.phase === 'idle' &&
    status.waitingFor === null &&
    (status.counts.pending > 0 || status.firstBackup.remaining > 0);

  useEffect(() => {
    if (startedBackup.current || busy || !readyToRun) return;
    startedBackup.current = true;
    void run('sync', () => PhotoSync.syncNow());
  }, [readyToRun, busy]);

  return (
    <Page title="Backup">
      <ReviewWaitingLink />
      <Card>
        <CardHeader className="flex-row items-center justify-between gap-3">
          <div>
            <CardTitle>Queue</CardTitle>
            <CardDescription>{detail || 'Checking the queue.'}</CardDescription>
          </div>
          <Button
            type="button"
            variant="outline"
            disabled={busy !== null}
            aria-busy={busy === 'refresh'}
            onClick={() => void run('refresh', () => queryClient.invalidateQueries({ queryKey: ['backup'] }))}
          >
            {busy === 'refresh' ? 'Refreshing…' : 'Refresh'}
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
          {notice ? <p className="mt-3 text-sm">{notice}</p> : null}
        </CardContent>
      </Card>

      {status?.configured ? (
        <DeleteBackedUpCard
          backedUp={status.counts.backedUp}
          pending={status.counts.pending}
          disabled={busy !== null}
          onFinished={() => {
            void queryClient.invalidateQueries({ queryKey: ['backup'] });
          }}
        />
      ) : null}

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
            aria-busy={busy === 'permissions'}
            onClick={() => void run('permissions', () => PhotoSync.requestPermissions())}
          >
            {busy === 'permissions' ? 'Asking…' : 'Allow photos and notifications'}
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={busy !== null}
            aria-busy={busy === 'battery'}
            onClick={() =>
              void run('battery', () => PhotoSync.requestBatteryOptimizationExemption())
            }
          >
            {busy === 'battery' ? 'Opening…' : 'Battery optimization'}
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Run</CardTitle>
          <CardDescription>
            New photos wait about a minute, then upload about once an hour. Back up now starts right
            away.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <label className="flex items-start gap-3 text-sm">
            <input
              type="checkbox"
              className="mt-0.5 size-4 accent-primary"
              checked={includeOtherPhotos}
              disabled={busy !== null || !settingsQuery.data}
              onChange={(event) =>
                void run('other', () =>
                  PhotoSync.configure({ includeOtherPhotos: event.target.checked }),
                )
              }
            />
            <span>
              Also back up photos from Downloads, WhatsApp, and other folders
              <span className="mt-1 block text-muted-foreground">
                Those photos wait in Review unless they show someone already in your library.
                Screenshots and camera scans always wait there. The first time this is on, older
                photos wait for Wi-Fi and charging.
              </span>
            </span>
          </label>
          <label className="flex items-start gap-3 text-sm">
            <input
              type="checkbox"
              className="mt-0.5 size-4 accent-primary"
              checked={!requireCharging}
              disabled={busy !== null || !settingsQuery.data}
              onChange={(event) =>
                void run('charging', () =>
                  PhotoSync.configure({ requireCharging: !event.target.checked }),
                )
              }
            />
            <span>
              Back up even when this phone isn&apos;t plugged in
              <span className="mt-1 block text-muted-foreground">
                Older photos and videos then upload on Wi-Fi without waiting to charge. This uses
                more battery.
              </span>
            </span>
          </label>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              disabled={busy !== null}
              aria-busy={busy === 'sync'}
              onClick={() => void run('sync', () => PhotoSync.syncNow())}
            >
              {busy === 'sync' ? 'Starting backup…' : 'Back up now'}
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={busy !== null}
              aria-busy={busy === 'retry'}
              onClick={() => void run('retry', () => PhotoSync.retryFailed())}
            >
              {busy === 'retry' ? 'Retrying…' : 'Retry failed'}
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={busy !== null}
              aria-busy={busy === 'schedule'}
              onClick={() =>
                void run('schedule', () =>
                  PhotoSync.setSchedule({
                    triggers: DEFAULT_TRIGGERS.map((trigger) => ({ ...trigger })),
                  }),
                )
              }
            >
              {busy === 'schedule' ? 'Saving…' : 'Use the default schedule'}
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={busy !== null}
              aria-busy={busy === 'folders'}
              onClick={() => void run('folders', loadFolders)}
            >
              {busy === 'folders' ? 'Loading folders…' : folders ? 'Refresh folders' : 'Choose folders'}
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
            A checked folder includes its subfolders. At least one stays checked.
          </p>
          <FormError error={error ?? statusQuery.error ?? settingsQuery.error ?? permissionsQuery.error} />
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

function olderPhotoWait(requireCharging: boolean): string {
  return requireCharging
    ? 'Older photos wait for Wi-Fi and charging before new uploads.'
    : 'Older photos upload on Wi-Fi even when this phone is not plugged in.';
}

const ACTION_NOTE: Record<string, string> = {
  sync: 'Backup started.',
  retry: 'Trying the failed ones again.',
  schedule: 'Schedule saved.',
  charging: 'Saved.',
  other: 'Saved.',
  permissions: 'Done.',
  battery: 'Opened battery settings.',
  folders: 'Folders loaded.',
  refresh: 'Updated.',
};

function describe(status: SyncStatus, requireCharging: boolean): string {
  const waiting =
    status.waitingFor === 'firstBackup'
      ? `${olderPhotoWait(requireCharging)} `
      : status.waitingFor
        ? `Waiting for ${WAITING[status.waitingFor]}. `
        : '';
  const phase = PHASE[status.phase];
  const paired = status.configured ? 'Connected.' : 'Not paired yet.';
  const first = status.firstBackup.complete
    ? ''
    : ` ${status.firstBackup.remaining} older photos are still waiting.`;
  return `${phase}. ${waiting}${paired}${first}`;
}
