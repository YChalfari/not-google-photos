import { App } from '@capacitor/app';
import { DEEP_LINK_PREFIX } from '@ngp/photo-sync';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { parsePairingUri } from '@ngp/shared';
import { errorMessage } from '@/lib/api';
import { finishLaunch, isNativeApp } from '@/lib/native';
import { pairPhone } from '@/lib/pairing';

/**
 * Android back button, notification links, and pairing links.
 * Cold start is finished before the session asks whether this phone is paired,
 * so a pairing link is redeemed before the connect screen decides.
 */
export function NativeRuntime() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!isNativeApp()) {
      finishLaunch();
      return;
    }

    let cancelled = false;
    let chain: Promise<void> = Promise.resolve();
    let lastUrl = '';
    let lastAt = 0;
    const handles: Array<{ remove: () => Promise<void> }> = [];

    const consume = (url: string) => {
      const now = Date.now();
      if (url === lastUrl && now - lastAt < 2000) return chain;
      lastUrl = url;
      lastAt = now;
      chain = chain
        .then(async () => {
          const parsed = parsePairingUri(url);
          if (parsed) {
            try {
              await pairPhone(parsed);
              await queryClient.invalidateQueries({ queryKey: ['device', 'connection'] });
              void navigate('/', { replace: true });
            } catch (error) {
              void navigate('/connect', { replace: true, state: { error: errorMessage(error) } });
            }
            return;
          }
          if (url.startsWith(DEEP_LINK_PREFIX)) {
            const rest = url.slice(DEEP_LINK_PREFIX.length) || '/';
            void navigate(rest.startsWith('/') ? rest : `/${rest}`);
          }
        })
        .catch(() => undefined);
      return chain;
    };

    void (async () => {
      try {
        const back = await App.addListener('backButton', ({ canGoBack }) => {
          if (canGoBack) window.history.back();
          else void App.minimizeApp();
        });
        const opened = await App.addListener('appUrlOpen', (event) => {
          void consume(event.url);
        });
        const resumed = await App.addListener('appStateChange', ({ isActive }) => {
          if (!isActive) return;
          void queryClient.invalidateQueries({ queryKey: ['device', 'connection'] }).then(() =>
            queryClient.invalidateQueries({
              predicate: (query) => query.queryKey[0] !== 'device',
            }),
          );
        });
        if (cancelled) {
          void back.remove();
          void opened.remove();
          void resumed.remove();
          return;
        }
        handles.push(back, opened, resumed);
        const launch = await App.getLaunchUrl();
        if (launch?.url) await consume(launch.url);
      } finally {
        if (!cancelled) finishLaunch();
      }
    })();

    return () => {
      cancelled = true;
      for (const handle of handles) void handle.remove();
    };
  }, [navigate, queryClient]);

  return null;
}
