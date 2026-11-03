import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { LoadingScreen } from '@/components/loading-screen';
import { ServerUnreachable } from '@/components/server-unreachable';
import { refreshDeviceConnection, usesDeviceAuth } from '@/lib/native';
import { useSession } from '@/session-context';

/** How long a normal attempt can sit on "Connecting" before we explain and offer Try again. */
const ONLINE_WAIT_MS = 8000;
/** Shorter when the phone already has no network. */
const OFFLINE_WAIT_MS = 2500;

/**
 * The wait before the library can open. Says what is happening, then gives up with Try again
 * instead of leaving the painting on screen with no explanation.
 */
export function ConnectionScreen({
  failed = false,
  error,
}: {
  /** The attempt already ended without an answer. */
  failed?: boolean;
  error?: unknown;
}) {
  const phone = usesDeviceAuth();
  const { refresh } = useSession();
  const queryClient = useQueryClient();
  const retrying = useRef(false);
  const attempt = useRef(0);
  const [phase, setPhase] = useState<'connecting' | 'failed'>(failed ? 'failed' : 'connecting');

  useEffect(() => {
    if (phase !== 'connecting') return;
    const ms = navigator.onLine ? ONLINE_WAIT_MS : OFFLINE_WAIT_MS;
    const id = window.setTimeout(() => setPhase('failed'), ms);
    return () => window.clearTimeout(id);
  }, [phase]);

  useEffect(() => {
    if (failed && !retrying.current) setPhase('failed');
  }, [failed]);

  async function tryAgain() {
    const id = ++attempt.current;
    retrying.current = true;
    setPhase('connecting');
    try {
      await queryClient.cancelQueries();
      await refreshDeviceConnection();
      await refresh();
      if (attempt.current !== id) return;
      if (queryClient.getQueryState(['server', 'info'])?.status === 'error') setPhase('failed');
    } catch {
      if (attempt.current === id) setPhase('failed');
    } finally {
      if (attempt.current === id) retrying.current = false;
    }
  }

  if (phase === 'connecting') {
    return <LoadingScreen label={phone ? 'Connecting to Wi-Fi' : 'Connecting'} />;
  }
  return <ServerUnreachable error={error} onRetry={tryAgain} />;
}
