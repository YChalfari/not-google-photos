import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { FormEvent } from 'react';
import { Navigate } from 'react-router-dom';
import { GuestFrame } from '@/components/shell';
import { ErrorState, Field, FormError, LoadingBlock } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { api } from '@/lib/api';
import { formText } from '@/lib/form';
import { useSession } from '@/session-context';

export function SetupPage() {
  const { info, ready, infoError, refresh } = useSession();
  const queryClient = useQueryClient();
  const setup = useMutation({
    mutationFn: (body: { name: string; email: string; password: string; serverName?: string }) =>
      api('setup.complete', { body }),
    onSuccess: async () => {
      await queryClient.invalidateQueries();
      await refresh();
    },
  });

  if (!ready) return <LoadingBlock label="Checking the server" />;
  if (infoError || !info)
    return <ErrorState title="The server is not answering" error={infoError} />;
  if (!info.setupRequired) return <Navigate to="/login" replace />;

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
          <CardDescription>
            Nobody has an account yet. Create the admin — that's you — and give the server a name
            your family will recognize.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form className="flex flex-col gap-4" onSubmit={onSubmit}>
            <Field label="Your name">
              <Input name="name" autoComplete="name" required maxLength={80} />
            </Field>
            <Field label="Email">
              <Input name="email" type="email" autoComplete="username" required />
            </Field>
            <Field
              label="Password"
              hint="At least 8 characters. Everyone else sets their own from an invite."
            >
              <Input
                name="password"
                type="password"
                autoComplete="new-password"
                required
                minLength={8}
              />
            </Field>
            <Field label="Server name" hint="Shown on phones when they pair. Optional.">
              <Input name="serverName" placeholder={info.name} maxLength={80} />
            </Field>
            <FormError error={setup.error} />
            <Button type="submit" disabled={setup.isPending}>
              {setup.isPending ? 'Creating the admin…' : 'Create the admin account'}
            </Button>
          </form>
        </CardContent>
      </Card>
    </GuestFrame>
  );
}
