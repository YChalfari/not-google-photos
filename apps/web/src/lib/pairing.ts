import type { ServerInfo } from '@ngp/shared';
import { PhotoSync } from '@ngp/photo-sync';
import { joinServerPath } from '@/lib/native';

/** Redeems a pairing code, then asks for the photos and notifications the backup needs. */
export async function pairPhone(input: {
  code: string;
  homeUrl?: string | null;
  remoteUrl?: string | null;
  serverId?: string | null;
}): Promise<void> {
  const homeUrl = input.homeUrl?.trim() || undefined;
  const remoteUrl = input.remoteUrl?.trim() || undefined;
  if (!homeUrl && !remoteUrl) {
    throw new Error('Enter a home or away address. This code did not include one.');
  }
  const blocked = await setupBlock(homeUrl, remoteUrl);
  if (blocked) throw new Error(blocked);
  await PhotoSync.pair({
    code: input.code,
    ...(homeUrl ? { homeUrl } : {}),
    ...(remoteUrl ? { remoteUrl } : {}),
    ...(input.serverId ? { serverId: input.serverId } : {}),
  });
  await PhotoSync.requestPermissions();
}

async function setupBlock(homeUrl?: string, remoteUrl?: string): Promise<string | null> {
  for (const base of [homeUrl, remoteUrl]) {
    if (!base) continue;
    try {
      const response = await fetch(joinServerPath(base, '/api/server/info'));
      if (!response.ok) continue;
      const info = (await response.json()) as ServerInfo;
      if (info.setupRequired) {
        return 'Finish setup in a browser on the home computer, then pair this phone.';
      }
      return null;
    } catch {
      continue;
    }
  }
  return null;
}
