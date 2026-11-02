import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type ReactNode } from 'react';
import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { LoadingScreen } from '@/components/loading-screen';
import { ServerUnreachable } from '@/components/server-unreachable';
import { ApiClientError, api } from '@/lib/api';
import {
  clearDeviceConnection,
  isLaunchFinished,
  refreshDeviceConnection,
  subscribeLaunch,
  usesDeviceAuth,
} from '@/lib/native';
import { SessionContext, useSession, type SessionValue } from '@/session-context';

export function SessionProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const deviceAuth = usesDeviceAuth();
  const [launchReady, setLaunchReady] = useState(isLaunchFinished);
  useEffect(() => subscribeLaunch(() => setLaunchReady(true)), []);
  const connection = useQuery({
    queryKey: ['device', 'connection'],
    enabled: deviceAuth && launchReady,
    retry: false,
    queryFn: () => refreshDeviceConnection(),
  });
  const paired = deviceAuth && connection.data === true;
  const connectionReady =
    !deviceAuth || (launchReady && (connection.isSuccess || connection.isError));
  const canTalk = !deviceAuth || paired;

  const info = useQuery({
    queryKey: ['server', 'info'],
    enabled: canTalk,
    queryFn: () => api('server.info'),
  });
  const me = useQuery({
    queryKey: ['auth', 'me'],
    enabled: Boolean(canTalk && info.data && !info.data.setupRequired),
    retry: false,
    queryFn: async () => {
      try {
        return await api('auth.me');
      } catch (error) {
        if (error instanceof ApiClientError && error.status === 401) {
          if (usesDeviceAuth()) {
            await clearDeviceConnection();
            queryClient.setQueryData(['device', 'connection'], false);
          }
          return null;
        }
        throw error;
      }
    },
  });

  const serverSettled = info.isSuccess
    ? Boolean(info.data.setupRequired || me.isSuccess || me.isError)
    : info.isError;
  const ready = connectionReady && (deviceAuth && !paired ? true : serverSettled);

  const value: SessionValue = {
    info: info.data,
    infoError: info.error,
    me: me.data,
    meError: me.error,
    ready,
    deviceAuth,
    paired,
    refresh: async () => {
      await queryClient.invalidateQueries();
    },
  };

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function RequireAuth() {
  const location = useLocation();
  const { info, me, ready, infoError, meError, deviceAuth, paired } = useSession();
  if (!ready) return <LoadingScreen label="Checking your session" />;
  if (deviceAuth && !paired) {
    return <Navigate to="/connect" replace state={{ from: location.pathname }} />;
  }
  if (infoError || !info) return <ServerUnreachable error={infoError} />;
  if (info.setupRequired) return <Navigate to="/setup" replace />;
  if (meError) {
    return (
      <div className="mx-auto max-w-md px-6 py-16 text-sm text-muted-foreground">
        {meError instanceof Error ? meError.message : 'Could not load your account.'}
      </div>
    );
  }
  if (!me) {
    return (
      <Navigate
        to={deviceAuth ? '/connect' : '/login'}
        replace
        state={{ from: location.pathname }}
      />
    );
  }
  return <Outlet />;
}

export function RequireAdmin() {
  const { me } = useSession();
  if (me && me.user.role !== 'admin') return <Navigate to="/" replace />;
  return <Outlet />;
}

export function GuestOnly() {
  const { info, me, ready, deviceAuth, paired } = useSession();
  if (!ready) return <LoadingScreen label="Checking your session" />;
  if (deviceAuth) return <Navigate to={paired ? '/' : '/connect'} replace />;
  if (info?.setupRequired) return <Navigate to="/setup" replace />;
  if (me) return <Navigate to="/" replace />;
  return <Outlet />;
}
