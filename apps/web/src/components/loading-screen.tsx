import type { ReactNode } from 'react';
import { Logo } from '@/components/logo';
import { Painting } from '@/components/painting';
import { cn } from '@/lib/utils';

export function LoadingScreen({
  label = 'Loading',
  note,
  action,
  fill = true,
}: {
  label?: string;
  note?: string;
  action?: ReactNode;
  /** Cover the viewport. Inline waits leave this off so the page around them stays put. */
  fill?: boolean;
}) {
  return (
    <div
      className={cn(fill ? 'fixed inset-0 z-10 overflow-y-auto px-4' : 'px-4 py-10')}
      role="status"
      aria-live="polite"
    >
      <div
        className={cn(
          'flex flex-col items-center justify-center gap-8',
          fill && 'min-h-full py-10',
        )}
      >
        <div className="flex items-center gap-3">
          <Logo className="size-10" />
          <p className="font-serif text-2xl">Not Google Photos</p>
        </div>
        <Painting className="w-full max-w-sm" />
        <div className="flex w-full max-w-sm flex-col items-center gap-3 text-center">
          <p>{label}</p>
          {note ? <p className="text-sm text-muted-foreground">{note}</p> : null}
          {action}
        </div>
      </div>
    </div>
  );
}
