import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { LoadingBlock } from '@/components/states';
import { ApiClientError, api } from '@/lib/api';
import { SessionContext, useSession, type SessionValue } from '@/session-context';

export function SessionProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const info = useQuery({
    queryKey: ['server', 'info'],
    queryFn: () => api('server.info'),
  });
  const me = useQuery({
    queryKey: ['auth', 'me'],
    enabled: Boolean(info.data && !info.data.setupRequired),
    retry: false,
    queryFn: async () => {
      try {
        return await api('auth.me');
      } catch (error) {
        if (error instanceof ApiClientError && error.status === 401) return null;
        throw error;
      }
    },
  });

  const ready = info.isSuccess && (info.data.setupRequired || me.isSuccess || me.isError);
  const value: SessionValue = {
    info: info.data,
    infoError: info.error,
    me: me.data,
    meError: me.error,
    ready,
    refresh: async () => {
      await queryClient.invalidateQueries();
    },
  };

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function RequireAuth() {
  const location = useLocation();
  const { info, me, ready, infoError, meError } = useSession();
  if (!ready) return <LoadingBlock label="Checking your session" />;
  if (infoError || !info) {
    return (
      <div className="mx-auto max-w-md px-6 py-16">
        <LoadingBlock label="Waiting for the server" />
        <p className="mt-4 text-sm text-muted-foreground">
          {infoError instanceof Error ? infoError.message : 'The server is not answering.'}
        </p>
      </div>
    );
  }
  if (info.setupRequired) return <Navigate to="/setup" replace />;
  if (meError) {
    return (
      <div className="mx-auto max-w-md px-6 py-16 text-sm text-muted-foreground">
        {meError instanceof Error ? meError.message : 'Could not load your account.'}
      </div>
    );
  }
  if (!me) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  return <Outlet />;
}

export function RequireAdmin() {
  const { me } = useSession();
  if (me && me.user.role !== 'admin') return <Navigate to="/" replace />;
  return <Outlet />;
}

export function GuestOnly() {
  const { info, me, ready } = useSession();
  if (!ready) return <LoadingBlock label="Checking your session" />;
  if (info?.setupRequired) return <Navigate to="/setup" replace />;
  if (me) return <Navigate to="/" replace />;
  return <Outlet />;
}
