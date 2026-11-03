import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { FormEvent } from 'react';
import { Link, Navigate } from 'react-router-dom';
import { GuestFrame } from '@/components/shell';
import { ConnectionScreen } from '@/components/connection-screen';
import { Field, FormError } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { api } from '@/lib/api';
import { formText } from '@/lib/form';
import { useSession } from '@/session-context';

export function SetupPage() {
  const { info, ready, infoError, refresh, deviceAuth, paired } = useSession();
  const queryClient = useQueryClient();
  const setup = useMutation({
    mutationFn: (body: { name: string; email: string; password: string; serverName?: string }) =>
      api('setup.complete', { body }),
    onSuccess: async () => {
      await queryClient.invalidateQueries();
      await refresh();
    },
  });

  if (!ready) return <ConnectionScreen />;
  if (deviceAuth && !paired) return <Navigate to="/connect" replace />;
  if (infoError || !info) return <ConnectionScreen failed error={infoError} />;
  if (!info.setupRequired) return <Navigate to={deviceAuth ? '/' : '/login'} replace />;
  if (deviceAuth) {
    return (
      <GuestFrame>
        <Card>
          <CardHeader>
            <CardTitle>Set up on a computer</CardTitle>
            <CardDescription>
              Set this up in a browser on the computer first. Then come back and pair this phone.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button asChild>
              <Link to="/connect">Back to pairing</Link>
            </Button>
          </CardContent>
        </Card>
      </GuestFrame>
    );
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const serverName = formText(form, 'serverName').trim();
    setup.mutate({
      name: formText(form, 'name'),
      email: formText(form, 'email'),
      password: formText(form, 'password'),
      ...(serverName ? { serverName } : {}),
    });
  }

  return (
    <GuestFrame>
      <Card>
        <CardHeader>
          <CardTitle>Set up this library</CardTitle>
          <CardDescription>Create the first account. You'll be the admin.</CardDescription>
        </CardHeader>
        <CardContent>
          <form className="flex flex-col gap-4" onSubmit={onSubmit}>
            <Field label="Your name">
              <Input name="name" autoComplete="name" required maxLength={80} />
            </Field>
            <Field label="Email">
              <Input name="email" type="email" autoComplete="username" required />
            </Field>
            <Field label="Password" hint="At least 8 characters.">
              <Input
                name="password"
                type="password"
                autoComplete="new-password"
                required
                minLength={8}
              />
            </Field>
            <Field label="Server name" hint="Optional. This is the name phones see.">
              <Input name="serverName" placeholder={info.name} maxLength={80} />
            </Field>
            <FormError error={setup.error} />
            <Button type="submit" disabled={setup.isPending}>
              {setup.isPending ? 'Creating…' : 'Create account'}
            </Button>
          </form>
        </CardContent>
      </Card>
    </GuestFrame>
  );
}
