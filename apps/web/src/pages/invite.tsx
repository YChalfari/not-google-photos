import { useMutation, useQuery } from '@tanstack/react-query';
import type { FormEvent } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { GuestFrame } from '@/components/shell';
import { ErrorState, Field, FormError, LoadingBlock } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { api } from '@/lib/api';
import { formText } from '@/lib/form';
import { formatWhen } from '@/lib/format';
import { useSession } from '@/session-context';

export function InvitePage() {
  const { token = '' } = useParams();
  const navigate = useNavigate();
  const { refresh } = useSession();
  const lookup = useQuery({
    queryKey: ['invites', 'lookup', token],
    enabled: token.length > 0,
    retry: false,
    queryFn: () => api('invites.lookup', { body: { token } }),
  });
  const accept = useMutation({
    mutationFn: (body: { token: string; name: string; email: string; password: string }) =>
      api('invites.accept', { body }),
    onSuccess: async () => {
      await refresh();
      void navigate('/', { replace: true });
    },
  });

  if (!token)
    return <ErrorState title="This invite link is incomplete" error={new Error('Missing token')} />;
  if (lookup.isPending) return <LoadingBlock label="Checking the invite" />;
  if (lookup.isError) {
    return (
      <GuestFrame>
        <ErrorState
          title="This invite can't be used"
          error={lookup.error}
          onRetry={() => void lookup.refetch()}
        />
      </GuestFrame>
    );
  }

  const invite = lookup.data.invite;

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    accept.mutate({
      token,
      name: formText(form, 'name'),
      email: formText(form, 'email'),
      password: formText(form, 'password'),
    });
  }

  return (
    <GuestFrame>
      <Card>
        <CardHeader>
          <CardTitle>Join {lookup.data.serverName}</CardTitle>
          <CardDescription>
            {invite.invitedBy ? `${invite.invitedBy} invited you. ` : ''}
            Pick a password. This link expires {formatWhen(invite.expiresAt)}.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form className="flex flex-col gap-4" onSubmit={onSubmit}>
            <Field label="Your name">
              <Input
                name="name"
                defaultValue={invite.name ?? ''}
                autoComplete="name"
                required
                maxLength={80}
              />
            </Field>
            <Field
              label="Email"
              hint={invite.email ? 'This invite is for this email.' : undefined}
            >
              <Input
                name="email"
                type="email"
                defaultValue={invite.email ?? ''}
                readOnly={Boolean(invite.email)}
                autoComplete="username"
                required
              />
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
            <FormError error={accept.error} />
            <Button type="submit" disabled={accept.isPending}>
              {accept.isPending ? 'Creating your account…' : 'Create account and sign in'}
            </Button>
          </form>
        </CardContent>
      </Card>
    </GuestFrame>
  );
}
