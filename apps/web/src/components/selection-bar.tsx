import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';

/** Sits above the phone tab bar while photos are selected. */
export function SelectionBar({
  count,
  onClear,
  children,
}: {
  count: number;
  onClear: () => void;
  children: ReactNode;
}) {
  return (
    <div className="fixed inset-x-4 bottom-[calc(4.25rem+env(safe-area-inset-bottom))] z-30 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border bg-card/95 px-3 py-2 shadow-lg backdrop-blur md:right-8 md:bottom-6 md:left-[calc(240px+2rem)]">
      <p className="text-sm">{count} selected</p>
      <div className="flex flex-wrap items-center gap-2">
        {children}
        <Button type="button" size="sm" variant="ghost" onClick={onClear}>
          Clear
        </Button>
      </div>
    </div>
  );
}
