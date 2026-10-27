import { useCallback } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { historyIndex } from '@/lib/history';

/** The open photo is a history entry, so Back closes it instead of leaving the app. */
export function useAssetParam() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const assetId = params.get('asset');

  const open = useCallback(
    (id: string) => {
      setParams((current) => {
        const next = new URLSearchParams(current);
        next.set('asset', id);
        return next;
      });
    },
    [setParams],
  );

  const select = useCallback(
    (id: string) => {
      setParams(
        (current) => {
          const next = new URLSearchParams(current);
          next.set('asset', id);
          return next;
        },
        { replace: true },
      );
    },
    [setParams],
  );

  const close = useCallback(() => {
    if (historyIndex() > 0) {
      void navigate(-1);
      return;
    }
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        next.delete('asset');
        return next;
      },
      { replace: true },
    );
  }, [navigate, setParams]);

  return { assetId, open, select, close };
}
