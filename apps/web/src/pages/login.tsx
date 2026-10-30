import { useMutation } from '@tanstack/react-query';
import type { FormEvent } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { GuestFrame } from '@/components/shell';
import { LoadingScreen } from '@/components/loading-screen';
import { Field, FormError } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { api } from '@/lib/api';
import { formText } from '@/lib/form';
import { useSession } from '@/session-context';

export function LoginPage() {
  const { info, ready, refresh } = useSession();
  const navigate = useNavigate();
  const location = useLocation();
  const from = (location.state as { from?: string } | null)?.from;
  const login = useMutation({
    mutationFn: (body: { email: string; password: string }) => api('auth.login', { body }),
    onSuccess: async () => {
      await refresh();
      void navigate(from && from !== '/login' ? from : '/', { replace: true });
    },
  });

  if (!ready) return <LoadingScreen label="Checking the server" />;

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    login.mutate({
      email: formText(form, 'email'),
      password: formText(form, 'password'),
    });
  }

  return (
    <GuestFrame>
      <Card>
        <CardHeader>
          <CardTitle>Sign in</CardTitle>
          {info ? <CardDescription>{info.name}</CardDescription> : null}
        </CardHeader>
        <CardContent>
          <form className="flex flex-col gap-4" onSubmit={onSubmit}>
            <Field label="Email">
              <Input name="email" type="email" autoComplete="username" required />
            </Field>
            <Field label="Password">
              <Input name="password" type="password" autoComplete="current-password" required />
            </Field>
            <FormError error={login.error} />
            <Button type="submit" disabled={login.isPending}>
              {login.isPending ? 'Signing in…' : 'Sign in'}
            </Button>
          </form>
          {info?.setupRequired ? (
            <p className="mt-4 text-sm text-muted-foreground">
              First time here?{' '}
              <Link className="text-primary underline-offset-4 hover:underline" to="/setup">
                Set up the server
              </Link>
              .
            </p>
          ) : null}
        </CardContent>
      </Card>
    </GuestFrame>
  );
}
