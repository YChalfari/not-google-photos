import { Logo } from '@/components/logo';
import { Painting } from '@/components/painting';
import { cn } from '@/lib/utils';

export function LoadingScreen({
  label = 'Loading',
  note,
  fill = true,
}: {
  label?: string;
  note?: string;
  /** Cover the viewport. Inline waits leave this off so the page around them stays put. */
  fill?: boolean;
}) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center gap-8 px-4 py-10',
        fill && 'min-h-dvh pt-[max(2.5rem,env(safe-area-inset-top))]',
      )}
      role="status"
      aria-live="polite"
    >
      <span className="sr-only">{label}</span>
      <div className="flex items-center gap-3">
        <Logo className="size-10" />
        <p className="font-serif text-2xl">Not Google Photos</p>
      </div>
      <Painting className="w-full max-w-sm" />
      {note ? <p className="max-w-sm text-center text-sm text-muted-foreground">{note}</p> : null}
    </div>
  );
}
