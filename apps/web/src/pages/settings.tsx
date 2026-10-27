import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { FormEvent } from 'react';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import QRCode from 'qrcode';
import { ErrorState, Field, FormError, LoadingBlock, Page } from '@/components/states';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { api } from '@/lib/api';
import { unpairThisPhone } from '@/lib/device';
import { formText } from '@/lib/form';
import { usesDeviceAuth } from '@/lib/native';
import { formatBytes, formatWhen } from '@/lib/format';
import { useSession } from '@/session-context';

export function SettingsPage() {
  const { me, refresh } = useSession();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const deviceAuth = usesDeviceAuth();
  const [unpairError, setUnpairError] = useState<unknown>(null);
  const [unpairing, setUnpairing] = useState(false);
  const storage = useQuery({ queryKey: ['me', 'storage'], queryFn: () => api('me.storage') });
  const devices = useQuery({ queryKey: ['devices'], queryFn: () => api('devices.list') });

  const profile = useMutation({
    mutationFn: (body: { name?: string; email?: string }) => api('me.update', { body }),
    onSuccess: async () => {
      await refresh();
    },
  });
  const password = useMutation({
    mutationFn: (body: { currentPassword: string; newPassword: string }) =>
      api('auth.changePassword', { body }),
  });
  const rename = useMutation({
    mutationFn: (input: { id: string; name: string }) =>
      api('devices.update', { params: { id: input.id }, body: { name: input.name } }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['devices'] });
    },
  });
  const revoke = useMutation({
    mutationFn: (id: string) => api('devices.revoke', { params: { id } }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['devices'] });
    },
  });

  function saveProfile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    profile.mutate({ name: formText(form, 'name'), email: formText(form, 'email') });
  }

  function savePassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    password.mutate(
      {
        currentPassword: formText(data, 'currentPassword'),
        newPassword: formText(data, 'newPassword'),
      },
      { onSuccess: () => form.reset() },
    );
  }

  return (
    <Page
      title="Settings"
      lede="Your account, how much of the drive you use, and the phones that can upload."
    >
      <Card>
        <CardHeader>
          <CardTitle>Profile</CardTitle>
          <CardDescription>
            Signed in as {me?.user.role === 'admin' ? 'an admin' : 'a member'}.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form className="flex flex-col gap-4" onSubmit={saveProfile}>
            <Field label="Name">
              <Input name="name" defaultValue={me?.user.name ?? ''} required maxLength={80} />
            </Field>
            <Field label="Email">
              <Input name="email" type="email" defaultValue={me?.user.email ?? ''} required />
            </Field>
            <FormError error={profile.error} />
            {profile.isSuccess ? <p className="text-sm text-primary">Saved.</p> : null}
            <Button type="submit" className="self-start" disabled={profile.isPending}>
              Save profile
            </Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Password</CardTitle>
          <CardDescription>Other browsers you're signed in on will be signed out.</CardDescription>
        </CardHeader>
        <CardContent>
          <form className="flex flex-col gap-4" onSubmit={savePassword}>
            <Field label="Current password">
              <Input
                name="currentPassword"
                type="password"
                autoComplete="current-password"
                required
              />
            </Field>
            <Field label="New password" hint="At least 8 characters.">
              <Input
                name="newPassword"
                type="password"
                autoComplete="new-password"
                required
                minLength={8}
              />
            </Field>
            <FormError error={password.error} />
            {password.isSuccess ? <p className="text-sm text-primary">Password updated.</p> : null}
            <Button
              type="submit"
              variant="outline"
              className="self-start"
              disabled={password.isPending}
            >
              Change password
            </Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Storage</CardTitle>
          <CardDescription>
            Originals are counted in full for you, even when the same file is also in someone else's
            library.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {storage.isPending ? <LoadingBlock label="Loading storage" /> : null}
          {storage.isError ? (
            <ErrorState error={storage.error} onRetry={() => void storage.refetch()} />
          ) : null}
          {storage.data ? (
            <dl className="grid grid-cols-2 gap-4 text-sm sm:grid-cols-3">
              <div>
                <dt className="text-muted-foreground">Used</dt>
                <dd className="font-serif text-2xl">{formatBytes(storage.data.usedBytes)}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Quota</dt>
                <dd className="font-serif text-2xl">
                  {storage.data.quotaBytes === null ? 'None' : formatBytes(storage.data.quotaBytes)}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Items</dt>
                <dd className="font-serif text-2xl">{storage.data.assetCount}</dd>
              </div>
            </dl>
          ) : null}
        </CardContent>
      </Card>

      <PairingCard />

      <Card>
        <CardHeader>
          <CardTitle>Devices</CardTitle>
          <CardDescription>Revoking a phone stops its uploads immediately.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {devices.isPending ? <LoadingBlock label="Loading devices" /> : null}
          {devices.isError ? (
            <ErrorState error={devices.error} onRetry={() => void devices.refetch()} />
          ) : null}
          {devices.data && devices.data.devices.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No phones paired yet. Show a code above.
            </p>
          ) : null}
          {devices.data?.devices.map((device) => (
            <form
              key={device.id}
              className="flex flex-col gap-3 rounded-lg border border-border p-3 sm:flex-row sm:items-center"
              onSubmit={(event) => {
                event.preventDefault();
                const name = formText(new FormData(event.currentTarget), 'name');
                if (name && name !== device.name) rename.mutate({ id: device.id, name });
              }}
            >
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <Input
                    name="name"
                    defaultValue={device.name}
                    aria-label="Device name"
                    className="max-w-xs"
                  />
                  <Badge variant="outline">{device.platform}</Badge>
                  {device.isCurrent ? <Badge>This device</Badge> : null}
                </div>
                <p className="mt-2 text-xs text-muted-foreground">
                  Last seen {formatWhen(device.lastSeenAt)} · added {formatWhen(device.createdAt)}
                </p>
              </div>
              <div className="flex gap-2">
                <Button type="submit" variant="outline" size="sm" disabled={rename.isPending}>
                  Rename
                </Button>
                <Dialog>
                  <DialogTrigger asChild>
                    <Button type="button" variant="destructive" size="sm">
                      Revoke
                    </Button>
                  </DialogTrigger>
                  <DialogContent>
                    <DialogTitle>Revoke {device.name}?</DialogTitle>
                    <DialogDescription>
                      Its token stops working immediately. Pair it again if you still want it to
                      upload.
                    </DialogDescription>
                    <div className="mt-6 flex justify-end gap-2">
                      <DialogClose asChild>
                        <Button type="button" variant="outline">
                          Keep it
                        </Button>
                      </DialogClose>
                      <DialogClose asChild>
                        <Button
                          type="button"
                          variant="destructive"
                          onClick={() => revoke.mutate(device.id)}
                        >
                          Revoke
                        </Button>
                      </DialogClose>
                    </div>
                  </DialogContent>
                </Dialog>
              </div>
            </form>
          ))}
          <FormError error={rename.error ?? revoke.error} />
        </CardContent>
      </Card>

      {deviceAuth ? (
        <Card>
          <CardHeader>
            <CardTitle>This phone</CardTitle>
            <CardDescription>
              Unpairing revokes this phone's key. It stops uploading until you pair it again.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col items-start gap-3">
            <FormError error={unpairError} />
            <Button
              type="button"
              variant="destructive"
              disabled={unpairing}
              onClick={() => {
                setUnpairing(true);
                setUnpairError(null);
                void unpairThisPhone()
                  .then(async () => {
                    queryClient.setQueryData(['device', 'connection'], false);
                    await refresh();
                    void navigate('/connect');
                  })
                  .catch((caught: unknown) => {
                    setUnpairError(caught);
                    setUnpairing(false);
                  });
              }}
            >
              {unpairing ? 'Unpairing…' : 'Unpair this phone'}
            </Button>
          </CardContent>
        </Card>
      ) : null}
    </Page>
  );
}

function PairingCard() {
  const queryClient = useQueryClient();
  const [created, setCreated] = useState<{
    id: string;
    code: string;
    uri: string;
    expiresAt: string;
  } | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: () => api('devices.createPairingCode'),
    onSuccess: (data) => {
      setCreated({ id: data.id, code: data.code, uri: data.uri, expiresAt: data.expiresAt });
    },
  });
  const status = useQuery({
    queryKey: ['devices', 'pairing', created?.id],
    enabled: Boolean(created),
    refetchInterval: (query) => (query.state.data?.status === 'pending' ? 2000 : false),
    queryFn: () => api('devices.pairingCodeStatus', { params: { id: created?.id ?? '' } }),
  });

  useEffect(() => {
    if (!created) return;
    let cancelled = false;
    void QRCode.toDataURL(created.uri, {
      margin: 1,
      width: 280,
      color: { dark: '#1c1915', light: '#fffdf8' },
    }).then((url) => {
      if (!cancelled) setQr(url);
    });
    return () => {
      cancelled = true;
    };
  }, [created]);

  useEffect(() => {
    if (status.data?.status === 'used') {
      void queryClient.invalidateQueries({ queryKey: ['devices'] });
    }
  }, [status.data?.status, queryClient]);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Pair a phone</CardTitle>
        <CardDescription>
          The phone app scans this code, learns the server address, and gets a device token for you.
          It expires in 10 minutes and works once.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {!created ? (
          <Button
            className="self-start"
            onClick={() => create.mutate()}
            disabled={create.isPending}
          >
            {create.isPending ? 'Preparing a code…' : 'Show a pairing code'}
          </Button>
        ) : (
          <div className="flex flex-col items-start gap-4 sm:flex-row">
            {qr ? (
              <img
                src={qr}
                alt="Pairing QR code"
                width={280}
                height={280}
                className="rounded-lg border border-border"
              />
            ) : (
              <div className="size-[280px] animate-pulse rounded-lg bg-secondary" />
            )}
            <div>
              <p className="font-serif text-3xl tracking-wide">{created.code}</p>
              <p className="mt-2 text-sm text-muted-foreground">
                Expires {formatWhen(created.expiresAt)}
              </p>
              {status.data?.status === 'used' ? (
                <p className="mt-3 text-sm text-primary">
                  Paired{status.data.device ? ` ${status.data.device.name}` : ''}. You can close
                  this code.
                </p>
              ) : status.data?.status === 'expired' ? (
                <p className="mt-3 text-sm text-destructive">This code expired. Show a new one.</p>
              ) : (
                <p className="mt-3 text-sm text-muted-foreground">
                  Waiting for a phone to scan it.
                </p>
              )}
              <Button
                className="mt-4"
                variant="outline"
                onClick={() => {
                  setCreated(null);
                  setQr(null);
                  create.mutate();
                }}
              >
                New code
              </Button>
            </div>
          </div>
        )}
        <FormError error={create.error ?? status.error} />
      </CardContent>
    </Card>
  );
}
