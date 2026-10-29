import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { FormEvent } from 'react';
import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import type { UserRole } from '@ngp/shared';
import { ErrorState, Field, FormError, LoadingBlock, Page } from '@/components/states';
import { useStatus } from '@/lib/status';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { api } from '@/lib/api';
import { formText } from '@/lib/form';
import { formatBytes, formatDate, formatWhen } from '@/lib/format';

export function AdminPage() {
  const queryClient = useQueryClient();
  const announce = useStatus();
  const [serverSaved, setServerSaved] = useState(false);
  const users = useQuery({ queryKey: ['admin', 'users'], queryFn: () => api('admin.users.list') });
  const invites = useQuery({ queryKey: ['admin', 'invites'], queryFn: () => api('invites.list') });
  const server = useQuery({
    queryKey: ['admin', 'server'],
    queryFn: () => api('admin.server.get'),
  });

  const saveServer = useMutation({
    mutationFn: (body: { name?: string; homeUrl?: string | null; remoteUrl?: string | null }) =>
      api('admin.server.update', { body }),
    onSuccess: async () => {
      setServerSaved(true);
      announce('Saved');
      await queryClient.invalidateQueries({ queryKey: ['admin', 'server'] });
      await queryClient.invalidateQueries({ queryKey: ['server', 'info'] });
    },
  });
  const updateUser = useMutation({
    mutationFn: (input: {
      id: string;
      body: { role?: UserRole; disabled?: boolean; quotaBytes?: number | null; name?: string };
    }) => api('admin.users.update', { params: { id: input.id }, body: input.body }),
    onSuccess: async (_user, input) => {
      await queryClient.invalidateQueries({ queryKey: ['admin', 'users'] });
      if (input.body.disabled === true) announce('Account disabled');
      else if (input.body.disabled === false) announce('Account enabled');
      else if (input.body.role) announce('Role updated');
      else announce('Saved');
    },
  });
  const createInvite = useMutation({
    mutationFn: (body: { email?: string; name?: string; role: UserRole; expiresInDays: number }) =>
      api('invites.create', { body }),
  });
  const revokeInvite = useMutation({
    mutationFn: (id: string) => api('invites.revoke', { params: { id } }),
    onSuccess: async () => {
      announce('Invite revoked');
      await queryClient.invalidateQueries({ queryKey: ['admin', 'invites'] });
    },
  });

  function onServer(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const home = formText(form, 'homeUrl').trim();
    const remote = formText(form, 'remoteUrl').trim();
    saveServer.mutate({
      name: formText(form, 'name'),
      homeUrl: home ? home : null,
      remoteUrl: remote ? remote : null,
    });
  }

  function onInvite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const email = formText(data, 'email').trim();
    const name = formText(data, 'name').trim();
    const days = Number(formText(data, 'expiresInDays') || '7');
    createInvite.mutate(
      {
        ...(email ? { email } : {}),
        ...(name ? { name } : {}),
        role: formText(data, 'role') === 'admin' ? 'admin' : 'member',
        expiresInDays: Number.isFinite(days) ? days : 7,
      },
      {
        onSuccess: () => {
          form.reset();
          void queryClient.invalidateQueries({ queryKey: ['admin', 'invites'] });
        },
      },
    );
  }

  return (
    <Page title="Admin">
      <Card>
        <CardHeader>
          <CardTitle>Server</CardTitle>
          <CardDescription>
            Leave a field blank to keep what's already set.
            {server.data ? ` ${server.data.library.message}` : ''}
          </CardDescription>
          {server.data ? (
            <p
              className={
                server.data.files.problemCount > 0
                  ? 'text-sm text-destructive'
                  : 'text-sm text-muted-foreground'
              }
            >
              {server.data.files.problemCount === 0
                ? 'No file problems.'
                : server.data.files.problemCount === 1
                  ? "1 stored file doesn't match. Left as it is."
                  : `${server.data.files.problemCount} stored files don't match. Left as they are.`}
            </p>
          ) : null}
        </CardHeader>
        <CardContent>
          {server.isPending ? <LoadingBlock label="Loading server settings" /> : null}
          {server.isError ? (
            <ErrorState error={server.error} onRetry={() => void server.refetch()} />
          ) : null}
          {server.data ? (
            <form
              className="flex flex-col gap-4"
              onInput={() => setServerSaved(false)}
              onSubmit={onServer}
            >
              <Field label="Name">
                <Input name="name" defaultValue={server.data.name} required maxLength={80} />
              </Field>
              <Field
                label="Home address"
                hint={server.data.defaults.homeUrl ?? 'No environment default'}
              >
                <Input
                  name="homeUrl"
                  placeholder="http://192.168.1.20:4810"
                  defaultValue={server.data.homeUrl ?? ''}
                />
              </Field>
              <Field label="Remote address" hint="Optional. For when a phone is away from home.">
                <Input
                  name="remoteUrl"
                  placeholder="https://photos.example.com"
                  defaultValue={server.data.remoteUrl ?? ''}
                />
              </Field>
              <FormError error={saveServer.error} />
              {serverSaved ? <p className="text-sm text-primary">Saved.</p> : null}
              <Button type="submit" className="self-start" pending={saveServer.isPending}>
                {saveServer.isPending ? 'Saving…' : 'Save server'}
              </Button>
            </form>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>People</CardTitle>
          <CardDescription>Disabling someone signs them out.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {users.isPending ? <LoadingBlock label="Loading people" /> : null}
          {users.isError ? (
            <ErrorState error={users.error} onRetry={() => void users.refetch()} />
          ) : null}
          {users.data?.users.map((user) => (
            <article key={user.id} className="rounded-lg border border-border p-4">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="font-medium">{user.name}</h3>
                <span className="text-sm text-muted-foreground">{user.email}</span>
                <Badge variant={user.role === 'admin' ? 'default' : 'outline'}>{user.role}</Badge>
                {user.status === 'disabled' ? <Badge variant="warning">Disabled</Badge> : null}
              </div>
              <p className="mt-2 text-sm text-muted-foreground">
                {user.storage.assetCount} items · {formatBytes(user.storage.usedBytes)}
                {user.storage.quotaBytes === null
                  ? ''
                  : ` of ${formatBytes(user.storage.quotaBytes)}`}{' '}
                · {user.deviceCount} {user.deviceCount === 1 ? 'device' : 'devices'} · last sign-in{' '}
                {formatWhen(user.lastLoginAt)}
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  pending={
                    updateUser.isPending &&
                    updateUser.variables?.id === user.id &&
                    updateUser.variables.body.role !== undefined
                  }
                  disabled={updateUser.isPending}
                  onClick={() =>
                    updateUser.mutate({
                      id: user.id,
                      body: { role: user.role === 'admin' ? 'member' : 'admin' },
                    })
                  }
                >
                  {updateUser.isPending &&
                  updateUser.variables?.id === user.id &&
                  updateUser.variables.body.role !== undefined
                    ? 'Saving…'
                    : `Make ${user.role === 'admin' ? 'member' : 'admin'}`}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  pending={
                    updateUser.isPending &&
                    updateUser.variables?.id === user.id &&
                    updateUser.variables.body.disabled !== undefined
                  }
                  disabled={updateUser.isPending}
                  onClick={() =>
                    updateUser.mutate({ id: user.id, body: { disabled: user.status === 'active' } })
                  }
                >
                  {updateUser.isPending &&
                  updateUser.variables?.id === user.id &&
                  updateUser.variables.body.disabled !== undefined
                    ? 'Saving…'
                    : user.status === 'active'
                      ? 'Disable'
                      : 'Enable'}
                </Button>
                <QuotaButton
                  used={user.storage.quotaBytes}
                  disabled={updateUser.isPending}
                  onSave={(quotaBytes) => updateUser.mutate({ id: user.id, body: { quotaBytes } })}
                />
              </div>
            </article>
          ))}
          <FormError error={updateUser.error} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Invites</CardTitle>
          <CardDescription>They choose their own password. The link is shown once.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <form className="grid gap-3 sm:grid-cols-2" onSubmit={onInvite}>
            <Field label="Name" hint="Optional.">
              <Input name="name" maxLength={80} />
            </Field>
            <Field label="Email" hint="Optional. Only this address can use the invite.">
              <Input name="email" type="email" />
            </Field>
            <Field label="Role">
              <select
                name="role"
                defaultValue="member"
                className="h-10 rounded-md border border-input bg-card px-3 text-sm"
              >
                <option value="member">Member</option>
                <option value="admin">Admin</option>
              </select>
            </Field>
            <Field label="Expires in days">
              <Input
                name="expiresInDays"
                type="number"
                min={1}
                max={90}
                defaultValue={7}
                required
              />
            </Field>
            <div className="sm:col-span-2">
              <FormError error={createInvite.error} />
              <Button type="submit" className="mt-2" disabled={createInvite.isPending}>
                {createInvite.isPending ? 'Creating…' : 'Create invite'}
              </Button>
            </div>
          </form>
          {createInvite.data ? (
            <InviteReveal url={createInvite.data.url} path={createInvite.data.path} />
          ) : null}
          {invites.isPending ? <LoadingBlock label="Loading invites" /> : null}
          {invites.isError ? (
            <ErrorState error={invites.error} onRetry={() => void invites.refetch()} />
          ) : null}
          <ul className="flex flex-col gap-2">
            {invites.data?.invites.map((invite) => (
              <li
                key={invite.id}
                className="flex flex-col gap-2 rounded-lg border border-border px-3 py-3 sm:flex-row sm:items-center sm:justify-between"
              >
                <div>
                  <p className="text-sm">
                    {invite.name ?? invite.email ?? 'Open invite'}{' '}
                    <Badge variant={invite.status === 'pending' ? 'default' : 'outline'}>
                      {invite.status}
                    </Badge>
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {invite.role}
                    {invite.email ? ` · ${invite.email}` : ''} · expires{' '}
                    {formatDate(invite.expiresAt)}
                  </p>
                </div>
                {invite.status === 'pending' ? (
                  <Button
                    size="sm"
                    variant="outline"
                    pending={revokeInvite.isPending && revokeInvite.variables === invite.id}
                    disabled={revokeInvite.isPending}
                    onClick={() => revokeInvite.mutate(invite.id)}
                  >
                    {revokeInvite.isPending && revokeInvite.variables === invite.id
                      ? 'Revoking…'
                      : 'Revoke'}
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
          <FormError error={revokeInvite.error} />
        </CardContent>
      </Card>
    </Page>
  );
}

function QuotaButton({
  used,
  disabled,
  onSave,
}: {
  used: number | null;
  disabled: boolean;
  onSave: (quotaBytes: number | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(used === null ? '' : String(Math.round(used / 1024 ** 3)));
  if (!open) {
    return (
      <Button size="sm" variant="outline" disabled={disabled} onClick={() => setOpen(true)}>
        Set quota
      </Button>
    );
  }
  return (
    <form
      className="flex items-center gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        const trimmed = value.trim();
        if (trimmed === '') {
          onSave(null);
          setOpen(false);
          return;
        }
        const gigabytes = Number(trimmed);
        if (!Number.isFinite(gigabytes) || gigabytes < 0) return;
        onSave(Math.round(gigabytes * 1024 ** 3));
        setOpen(false);
      }}
    >
      <Input
        aria-label="Quota in gigabytes"
        inputMode="decimal"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        placeholder="Gigabytes, or blank for none"
        className="h-8 w-36"
      />
      <Button size="sm" type="submit">
        Save
      </Button>
    </form>
  );
}

function InviteReveal({ url, path }: { url: string; path: string }) {
  const [qr, setQr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void QRCode.toDataURL(url, {
      margin: 1,
      width: 220,
      color: { dark: '#1c1915', light: '#fffdf8' },
    }).then((value) => {
      if (!cancelled) setQr(value);
    });
    return () => {
      cancelled = true;
    };
  }, [url]);
  return (
    <div className="flex flex-col gap-3 rounded-lg bg-accent/60 p-4 sm:flex-row sm:items-center">
      {qr ? (
        <img
          src={qr}
          alt="Invite QR code"
          width={160}
          height={160}
          className="rounded-md bg-[#fffdf8] p-2"
        />
      ) : null}
      <div className="min-w-0">
        <p className="text-sm font-medium">Invite link, shown once</p>
        <p className="mt-1 text-sm break-all">{url}</p>
        <p className="mt-1 text-xs text-muted-foreground">Path {path}</p>
        <Button
          className="mt-3"
          size="sm"
          variant="outline"
          type="button"
          onClick={() => {
            void navigator.clipboard.writeText(url).then(() => setCopied(true));
          }}
        >
          {copied ? 'Copied' : 'Copy link'}
        </Button>
      </div>
    </div>
  );
}
