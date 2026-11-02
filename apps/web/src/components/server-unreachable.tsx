import { PhotoSync, type DiscoveredServer } from '@ngp/photo-sync';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { GuestFrame } from '@/components/shell';
import { Field, FormError } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { errorMessage } from '@/lib/api';
import {
  clearDeviceConnection,
  deviceServerAddress,
  refreshDeviceConnection,
  usesDeviceAuth,
} from '@/lib/native';
import { useSession } from '@/session-context';

/** Shown when the saved server address no longer answers, so the phone can point at a new one. */
export function ServerUnreachable({ error }: { error: unknown }) {
  const deviceAuth = usesDeviceAuth();
  const { refresh } = useSession();
  const queryClient = useQueryClient();
  const [homeUrl, setHomeUrl] = useState(() => deviceServerAddress() ?? '');
  const [servers, setServers] = useState<DiscoveredServer[] | null>(null);
  const [looking, setLooking] = useState(deviceAuth);
  const [pending, setPending] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const tried = deviceServerAddress();

  useEffect(() => {
    if (!deviceAuth) return;
    let cancelled = false;
    void PhotoSync.getSettings()
      .then((config) => {
        if (cancelled) return;
        setHomeUrl((current) => current || config.settings.homeUrl || '');
      })
      .catch(() => undefined);
    void PhotoSync.discoverServers({ timeoutMs: 4000 })
      .then((result) => {
        if (cancelled) return;
        setServers(result.servers);
        const found = result.servers.length === 1 ? result.servers[0] : null;
        if (found) {
          setHomeUrl((current) => (current && current !== tried ? current : found.url));
        }
      })
      .catch(() => {
        if (!cancelled) setServers([]);
      })
      .finally(() => {
        if (!cancelled) setLooking(false);
      });
    return () => {
      cancelled = true;
    };
  }, [deviceAuth, tried]);

  async function tryAgain() {
    setPending(true);
    setFormError(null);
    try {
      await refreshDeviceConnection();
      await refresh();
    } catch (caught) {
      setFormError(errorMessage(caught));
    } finally {
      setPending(false);
    }
  }

  async function useAddress(next: string) {
    const address = next.trim();
    if (!address) {
      setFormError('Enter the home address.');
      return;
    }
    setPending(true);
    setFormError(null);
    try {
      await PhotoSync.configure({ homeUrl: address });
      await refreshDeviceConnection();
      await refresh();
    } catch (caught) {
      setFormError(errorMessage(caught));
    } finally {
      setPending(false);
    }
  }

  async function pairAgain() {
    setPending(true);
    setFormError(null);
    try {
      await clearDeviceConnection();
      queryClient.setQueryData(['device', 'connection'], false);
    } catch (caught) {
      setFormError(errorMessage(caught));
      setPending(false);
    }
  }

  const detail = friendlyError(error);

  return (
    <GuestFrame>
      <Card>
        <CardHeader>
          <CardTitle>The server isn't answering</CardTitle>
          <CardDescription>
            {deviceAuth
              ? 'This phone is still using its saved address. If the Wi-Fi address changed, enter the new one.'
              : 'Check that the server is running, then try again.'}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {deviceAuth && tried ? (
            <p className="text-sm text-muted-foreground">
              Last address: <span className="break-all text-foreground">{tried}</span>
            </p>
          ) : null}
          {detail ? <p className="text-sm text-muted-foreground">{detail}</p> : null}
          {deviceAuth ? (
            <form
              className="flex flex-col gap-4"
              onSubmit={(event) => {
                event.preventDefault();
                void useAddress(homeUrl);
              }}
            >
              <Field
                label="Home address"
                hint="The address of this computer on Wi-Fi, including the port."
              >
                <Input
                  name="homeUrl"
                  type="url"
                  inputMode="url"
                  autoComplete="off"
                  placeholder="http://192.168.1.20:4810"
                  value={homeUrl}
                  onChange={(event) => setHomeUrl(event.target.value)}
                />
              </Field>
              {formError ? <FormError error={new Error(formError)} /> : null}
              <div className="flex flex-wrap gap-2">
                <Button type="submit" disabled={pending}>
                  {pending ? 'Trying…' : 'Use this address'}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  disabled={pending}
                  onClick={() => void tryAgain()}
                >
                  Try again
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  disabled={pending}
                  onClick={() => void pairAgain()}
                >
                  Pair again
                </Button>
              </div>
            </form>
          ) : (
            <>
              {formError ? <FormError error={new Error(formError)} /> : null}
              <Button type="button" disabled={pending} onClick={() => void tryAgain()}>
                {pending ? 'Trying…' : 'Try again'}
              </Button>
            </>
          )}
          {deviceAuth ? (
            <div className="text-sm">
              {looking ? <p className="text-muted-foreground">Looking on the network…</p> : null}
              {servers ? (
                <ul className="flex flex-col gap-2">
                  {servers.length === 0 ? (
                    <li className="text-muted-foreground">Couldn't find one on this network.</li>
                  ) : (
                    servers.map((server) => (
                      <li key={`${server.host}:${server.port}`} className="flex items-center gap-2">
                        <span className="min-w-0 flex-1 truncate">
                          {server.name} · {server.url}
                        </span>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled={pending}
                          onClick={() => void useAddress(server.url)}
                        >
                          Use
                        </Button>
                      </li>
                    ))
                  )}
                </ul>
              ) : null}
            </div>
          ) : null}
        </CardContent>
      </Card>
    </GuestFrame>
  );
}

function friendlyError(error: unknown): string | null {
  const message = errorMessage(error, '');
  if (!message || message === 'Failed to fetch' || message === 'Load failed') return null;
  return message;
}
