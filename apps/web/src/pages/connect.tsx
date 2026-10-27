import { PhotoSync, type DiscoveredServer } from '@ngp/photo-sync';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { parsePairingUri } from '@ngp/shared';
import { GuestFrame } from '@/components/shell';
import { Field, FormError, LoadingBlock } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { errorMessage } from '@/lib/api';
import { isNativeApp, usesDeviceAuth } from '@/lib/native';
import { pairPhone } from '@/lib/pairing';
import { useSession } from '@/session-context';

function destination(state: unknown): string {
  const from = (state as { from?: string } | null)?.from;
  if (!from || !from.startsWith('/') || from.startsWith('//')) return '/';
  if (from === '/connect' || from === '/login' || from === '/setup') return '/';
  return from;
}

export function ConnectPage() {
  const { ready, paired } = useSession();
  const location = useLocation();
  const queryClient = useQueryClient();
  const [homeUrl, setHomeUrl] = useState('');
  const [remoteUrl, setRemoteUrl] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(
    () => (location.state as { error?: string } | null)?.error ?? null,
  );
  const [pending, setPending] = useState(false);
  const [servers, setServers] = useState<DiscoveredServer[] | null>(null);

  useEffect(() => {
    if (!isNativeApp()) return;
    void PhotoSync.getSettings()
      .then((config) => {
        setHomeUrl((current) => current || config.settings.homeUrl || '');
        setRemoteUrl((current) => current || config.settings.remoteUrl || '');
      })
      .catch(() => undefined);
  }, []);

  if (!ready) return <LoadingBlock label="Checking this phone" />;
  if (!usesDeviceAuth()) return <Navigate to="/login" replace />;
  if (paired) return <Navigate to={destination(location.state)} replace />;

  async function pair(input: {
    code: string;
    homeUrl?: string | null;
    remoteUrl?: string | null;
    serverId?: string | null;
  }) {
    setPending(true);
    setError(null);
    try {
      await pairPhone(input);
      await queryClient.invalidateQueries({ queryKey: ['device', 'connection'] });
    } catch (caught) {
      setError(errorMessage(caught));
      setPending(false);
    }
  }

  return (
    <GuestFrame>
      <Card>
        <CardHeader>
          <CardTitle>Connect this phone</CardTitle>
          <CardDescription>
            Scan the pairing code from Settings on a computer that's already signed in. The phone
            keeps its own key for uploads and for opening the library.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form
            className="flex flex-col gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              void pair({ code, homeUrl, remoteUrl });
            }}
          >
            <Field
              label="Home address"
              hint="The server on your home network. Plain HTTP is fine there."
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
            <Field label="Away address" hint="Optional. Tailscale or your own HTTPS address.">
              <Input
                name="remoteUrl"
                type="url"
                inputMode="url"
                autoComplete="off"
                placeholder="https://photos.example.com"
                value={remoteUrl}
                onChange={(event) => setRemoteUrl(event.target.value)}
              />
            </Field>
            <Field label="Pairing code">
              <Input
                name="code"
                autoComplete="off"
                spellCheck={false}
                value={code}
                onChange={(event) => setCode(event.target.value)}
                required
              />
            </Field>
            {error ? <FormError error={new Error(error)} /> : null}
            <div className="flex flex-wrap gap-2">
              <Button type="submit" disabled={pending}>
                {pending ? 'Pairing…' : 'Pair this phone'}
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={pending}
                onClick={() => {
                  void PhotoSync.scanQrCode()
                    .then((result) => {
                      const parsed = parsePairingUri(result.value);
                      if (!parsed) {
                        setError('That QR code is not a pairing code.');
                        return;
                      }
                      if (parsed.homeUrl) setHomeUrl(parsed.homeUrl);
                      if (parsed.remoteUrl) setRemoteUrl(parsed.remoteUrl);
                      setCode(parsed.code);
                      return pair(parsed);
                    })
                    .catch((caught: unknown) => setError(errorMessage(caught)));
                }}
              >
                Scan QR code
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={pending}
                onClick={() => {
                  setServers(null);
                  void PhotoSync.discoverServers({ timeoutMs: 4000 })
                    .then((result) => setServers(result.servers))
                    .catch((caught: unknown) => setError(errorMessage(caught)));
                }}
              >
                Find on the network
              </Button>
            </div>
          </form>
          {servers ? (
            <ul className="mt-4 flex flex-col gap-2 text-sm">
              {servers.length === 0 ? (
                <li className="text-muted-foreground">
                  No Not Google Photos server announced itself.
                </li>
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
                      onClick={() => setHomeUrl(server.url)}
                    >
                      Use
                    </Button>
                  </li>
                ))
              )}
            </ul>
          ) : null}
        </CardContent>
      </Card>
    </GuestFrame>
  );
}
