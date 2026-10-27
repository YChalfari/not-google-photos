import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { errorMessage } from '@/lib/api';
import { cn } from '@/lib/utils';

export function Page({
  title,
  lede,
  wide = false,
  children,
}: {
  title: string;
  lede?: string;
  wide?: boolean;
  children: ReactNode;
}) {
  return (
    <div className={cn('mx-auto flex w-full flex-col gap-6', wide ? 'max-w-6xl' : 'max-w-3xl')}>
      <header>
        <h1 className="font-serif text-3xl font-medium tracking-tight text-balance">{title}</h1>
        {lede ? <p className="mt-2 max-w-2xl text-muted-foreground">{lede}</p> : null}
      </header>
      {children}
    </div>
  );
}

export function LoadingBlock({ label = 'Loading' }: { label?: string }) {
  return (
    <div className="flex flex-col gap-3" role="status" aria-live="polite">
      <span className="sr-only">{label}</span>
      <div className="h-8 w-40 animate-pulse rounded-md bg-secondary" />
      <div className="h-28 animate-pulse rounded-xl bg-secondary" />
      <div className="h-28 animate-pulse rounded-xl bg-secondary" />
    </div>
  );
}

export function EmptyState({
  title,
  body,
  action,
}: {
  title: string;
  body: string;
  action?: ReactNode;
}) {
  return (
    <div className="rounded-xl border border-dashed border-border bg-card px-6 py-12 text-center">
      <h2 className="font-serif text-2xl">{title}</h2>
      <p className="mx-auto mt-2 max-w-md text-muted-foreground">{body}</p>
      {action ? <div className="mt-5 flex justify-center">{action}</div> : null}
    </div>
  );
}

export function ErrorState({
  title = 'Something went wrong',
  error,
  onRetry,
}: {
  title?: string;
  error: unknown;
  onRetry?: () => void;
}) {
  return (
    <div className="rounded-xl border border-destructive/30 bg-card px-5 py-6" role="alert">
      <h2 className="font-serif text-xl">{title}</h2>
      <p className="mt-2 text-sm text-muted-foreground">{errorMessage(error)}</p>
      {onRetry ? (
        <Button className="mt-4" variant="outline" onClick={onRetry}>
          Try again
        </Button>
      ) : null}
    </div>
  );
}

export function FormError({ error }: { error: unknown }) {
  if (!error) return null;
  return (
    <p className="text-sm text-destructive" role="alert">
      {errorMessage(error)}
    </p>
  );
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-sm font-medium">{label}</span>
      {children}
      {hint ? <span className="text-xs text-muted-foreground">{hint}</span> : null}
    </label>
  );
}
