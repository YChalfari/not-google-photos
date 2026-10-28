import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { StatusContext } from '@/lib/status';

interface Notice {
  id: number;
  message: string;
  undo?: () => void;
}

/** A short confirmation above the phone tab bar. Undo stays a little longer than a plain note. */
export function StatusProvider({ children }: { children: ReactNode }) {
  const [notice, setNotice] = useState<Notice | null>(null);
  const timer = useRef<number | null>(null);

  const announce = useCallback((message: string, undo?: () => void) => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    const id = Date.now();
    setNotice({ id, message, undo });
    timer.current = window.setTimeout(
      () => {
        setNotice((current) => (current?.id === id ? null : current));
      },
      undo ? 4000 : 2500,
    );
  }, []);

  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );

  return (
    <StatusContext.Provider value={announce}>
      {children}
      <div
        role="status"
        aria-live="polite"
        className="pointer-events-none fixed inset-x-0 bottom-[calc(7.75rem+env(safe-area-inset-bottom))] z-40 flex justify-center px-4 md:bottom-24"
      >
        {notice ? (
          <div className="pointer-events-auto flex items-center gap-3 rounded-full border border-border bg-card px-4 py-2 text-sm shadow-lg">
            <span>{notice.message}</span>
            {notice.undo ? (
              <button
                type="button"
                className="font-medium text-primary"
                onClick={() => {
                  const run = notice.undo;
                  if (timer.current !== null) window.clearTimeout(timer.current);
                  timer.current = null;
                  setNotice(null);
                  run?.();
                }}
              >
                Undo
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    </StatusContext.Provider>
  );
}
