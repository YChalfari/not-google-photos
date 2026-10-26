import { App } from '@capacitor/app';
import { DEEP_LINK_PREFIX, DEFAULT_TRIGGERS, PhotoSync, type SyncStatus } from '@ngp/photo-sync';

const lede = document.querySelector<HTMLElement>('#lede')!;
const route = document.querySelector<HTMLElement>('#route')!;
const stats = document.querySelector<HTMLElement>('#stats')!;
const detail = document.querySelector<HTMLElement>('#detail')!;
const permissions = document.querySelector<HTMLElement>('#permissions')!;
const servers = document.querySelector<HTMLElement>('#servers')!;
const folders = document.querySelector<HTMLElement>('#folders-list')!;
const log = document.querySelector<HTMLOListElement>('#log')!;
const form = document.querySelector<HTMLFormElement>('#connect')!;

function note(title: string, value: unknown) {
  const item = document.createElement('li');
  const strong = document.createElement('strong');
  strong.textContent = title;
  item.append(strong, ' ', typeof value === 'string' ? value : JSON.stringify(value));
  log.prepend(item);
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

async function call<T>(title: string, action: () => Promise<T>): Promise<T | undefined> {
  try {
    const value = await action();
    note(title, value ?? 'done');
    return value;
  } catch (error) {
    note(title, messageOf(error));
    return undefined;
  }
}

function renderStatus(status: SyncStatus) {
  lede.textContent = status.available
    ? 'This phone keeps its own queue and uploads when the schedule says so.'
    : 'This browser can show the screen, but backup runs only inside the Android app.';
  const rows: [string, string][] = [
    ['Backed up', String(status.counts.backedUp)],
    ['Pending', String(status.counts.pending)],
    ['Failed', String(status.counts.failed)],
    ['Today left', String(status.todayNotBackedUp)],
  ];
  stats.replaceChildren(
    ...rows.map(([label, value]) => {
      const wrap = document.createElement('div');
      const dt = document.createElement('dt');
      const dd = document.createElement('dd');
      dt.textContent = label;
      dd.textContent = value;
      wrap.append(dt, dd);
      return wrap;
    }),
  );
  const waiting = status.waitingFor ? `Waiting for ${status.waitingFor}. ` : '';
  const phase = status.phase === 'idle' ? 'Idle' : `Working: ${status.phase}`;
  const current = status.current ? ` Uploading ${status.current.fileName} (${status.current.index} of ${status.current.of}).` : '';
  const first = status.firstBackup.complete ? '' : ` First backup still has ${status.firstBackup.remaining} older items.`;
  detail.textContent = `${phase}. ${waiting}${status.configured ? 'Paired with a server.' : 'No server paired yet.'}${current}${first}`;
}

async function refresh() {
  const status = await PhotoSync.getStatus();
  renderStatus(status);
  const perms = await PhotoSync.checkPermissions();
  permissions.textContent = `Photos: ${perms.media}. Location in photos: ${perms.mediaLocation}. Notifications: ${perms.notifications}. Battery exemption: ${perms.batteryOptimizationExempt ? 'yes' : 'no'}.`;
}

function showDeepLink(url: string) {
  const path = url.startsWith(DEEP_LINK_PREFIX) ? url.slice(DEEP_LINK_PREFIX.length) || '/' : url;
  route.textContent = path.startsWith('/') ? `Opened ${path}` : `Opened ${url}`;
}

function field(name: string): string {
  const input = form.elements.namedItem(name);
  return input instanceof HTMLInputElement ? input.value.trim() : '';
}

document.querySelector('#refresh')!.addEventListener('click', () => void refresh());

document.querySelector('#request-permissions')!.addEventListener('click', () =>
  void call('Permissions', () => PhotoSync.requestPermissions()).then(() => refresh()),
);

document.querySelector('#battery')!.addEventListener('click', () =>
  void call('Battery', () => PhotoSync.requestBatteryOptimizationExemption()),
);

document.querySelector('#sync')!.addEventListener('click', () => void call('Back up now', () => PhotoSync.syncNow()));
document.querySelector('#retry')!.addEventListener('click', () => void call('Retry failed', () => PhotoSync.retryFailed()));

document.querySelector('#schedule')!.addEventListener('click', () =>
  void call('Schedule', () => PhotoSync.setSchedule({ triggers: DEFAULT_TRIGGERS.map((trigger) => ({ ...trigger })) })),
);

document.querySelector('#folders')!.addEventListener('click', async () => {
  const result = await call('Folders', () => PhotoSync.listFolders());
  folders.replaceChildren();
  for (const folder of result?.folders ?? []) {
    const item = document.createElement('li');
    item.textContent = `${folder.name} · ${folder.id} · ${folder.count}${folder.selected ? ' · backing up' : ''}`;
    folders.append(item);
  }
});

document.querySelector('#memories')!.addEventListener('click', () =>
  void call('Memories', () => PhotoSync.scheduleMemoryNotifications({ time: '09:00', enabled: true })),
);

document.querySelector('#save-address')!.addEventListener('click', () => {
  const homeUrl = field('homeUrl');
  const remoteUrl = field('remoteUrl');
  if (!homeUrl && !remoteUrl) {
    note('Address', 'Enter a home or away address first.');
    return;
  }
  void call('Address', () =>
    PhotoSync.configure({
      ...(homeUrl ? { homeUrl } : {}),
      ...(remoteUrl ? { remoteUrl } : {}),
    }),
  );
});

form.addEventListener('submit', (event) => {
  event.preventDefault();
  const code = field('code');
  if (!code) {
    note('Pair', 'Enter the pairing code from the server.');
    return;
  }
  const homeUrl = field('homeUrl');
  const remoteUrl = field('remoteUrl');
  void call('Pair', () =>
    PhotoSync.pair({
      code,
      ...(homeUrl ? { homeUrl } : {}),
      ...(remoteUrl ? { remoteUrl } : {}),
    }),
  ).then(() => refresh());
});

document.querySelector('#discover')!.addEventListener('click', async () => {
  const result = await call('Discovery', () => PhotoSync.discoverServers({ timeoutMs: 4000 }));
  servers.replaceChildren();
  if (!result?.servers.length) {
    const item = document.createElement('li');
    item.textContent = 'No Not Google Photos server announced itself.';
    servers.append(item);
    return;
  }
  for (const server of result.servers) {
    const item = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'ghost';
    button.textContent = `Use ${server.name}`;
    button.addEventListener('click', () => {
      const input = form.elements.namedItem('homeUrl');
      if (input instanceof HTMLInputElement) input.value = server.url;
    });
    item.append(`${server.name} · ${server.url}`, ' ', button);
    servers.append(item);
  }
});

void PhotoSync.addListener('statusChanged', renderStatus);
void PhotoSync.addListener('progress', renderStatus);

void App.addListener('backButton', ({ canGoBack }) => {
  if (canGoBack) window.history.back();
  else void App.minimizeApp();
});

void App.addListener('appUrlOpen', (event) => showDeepLink(event.url));
void App.getLaunchUrl().then((launch) => {
  if (launch?.url) showDeepLink(launch.url);
});

void refresh();
