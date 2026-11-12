import type { AssetSummary } from '@ngp/shared';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, type PointerEvent } from 'react';
import { Link } from 'react-router-dom';
import { PhotoGrid } from '@/components/photo-grid';
import { SelectionBar } from '@/components/selection-bar';
import { EmptyState, ErrorState, LoadingBlock, Page } from '@/components/states';
import { Button } from '@/components/ui/button';
import { api, errorMessage } from '@/lib/api';
import { formatBytes } from '@/lib/format';
import { assetUrl } from '@/lib/native';
import { useStatus } from '@/lib/status';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';

const MODE_KEY = 'ngp.review.mode';
/** acceptReview and rejectReview take at most this many ids. */
const REVIEW_BATCH = 1000;

type ReviewMode = 'swipe' | 'grid';

function storedMode(): ReviewMode {
  try {
    return localStorage.getItem(MODE_KEY) === 'grid' ? 'grid' : 'swipe';
  } catch {
    return 'swipe';
  }
}

/** Shown on the library and Backup screens while photos are waiting. */
export function ReviewWaitingLink() {
  const review = useQuery({
    queryKey: ['assets', 'review', 'count'],
    queryFn: () => api('assets.review', { query: { limit: 1 } }),
  });
  const total = review.data?.total ?? 0;
  if (total < 1) return null;
  const label = total === 1 ? '1 photo is waiting' : `${total.toLocaleString()} photos are waiting`;
  return (
    <p className="text-sm">
      <Link to="/review" className="font-medium text-primary underline-offset-4 hover:underline">
        {label}
      </Link>{' '}
      <span className="text-muted-foreground">
        ({formatBytes(review.data?.totalBytes ?? 0)}) for a yes or no.
      </span>
    </p>
  );
}

export function ReviewPage() {
  const queryClient = useQueryClient();
  const announce = useStatus();
  const [mode, setMode] = useState<ReviewMode>(storedMode);
  const [hiding, setHiding] = useState<ReadonlySet<string>>(() => new Set());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmKeepAll, setConfirmKeepAll] = useState(false);
  const review = useInfiniteQuery({
    queryKey: ['assets', 'review', 'items'],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      api('assets.review', {
        query: pageParam ? { cursor: pageParam, limit: 100 } : { limit: 100 },
      }),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const loaded = review.data?.pages.flatMap((page) => page.items) ?? [];
  const loadedIds = loaded.map((item) => item.id).join('\n');
  const items = loaded.filter((item) => !hiding.has(item.id));
  const total = Math.max(0, (review.data?.pages[0]?.total ?? 0) - hiding.size);

  useEffect(() => {
    const present = new Set(loadedIds.split('\n').filter((id) => id.length > 0));
    setHiding((current) => {
      const next = new Set([...current].filter((id) => present.has(id)));
      if (next.size === current.size && [...current].every((id) => next.has(id))) return current;
      return next;
    });
  }, [loadedIds]);

  useEffect(() => {
    if (items.length === 0 && review.hasNextPage && !review.isFetchingNextPage && !review.isError) {
      void review.fetchNextPage();
    }
  }, [
    items.length,
    review.hasNextPage,
    review.isFetchingNextPage,
    review.isError,
    review.fetchNextPage,
  ]);

  function remember(next: ReviewMode) {
    setMode(next);
    setSelected(new Set());
    try {
      localStorage.setItem(MODE_KEY, next);
    } catch {
      // The choice still applies for this visit.
    }
  }

  async function decide(ids: string[], action: 'keep' | 'no') {
    if (ids.length === 0 || busy) return;
    setBusy(true);
    setError(null);
    setHiding((current) => new Set([...current, ...ids]));
    const done = new Set<string>();
    try {
      for (let index = 0; index < ids.length; index += REVIEW_BATCH) {
        const batch = ids.slice(index, index + REVIEW_BATCH);
        if (action === 'keep') await api('assets.acceptReview', { body: { ids: batch } });
        else await api('assets.rejectReview', { body: { ids: batch } });
        for (const id of batch) done.add(id);
      }
      setSelected(new Set());
      announce(action === 'keep' ? 'Kept' : 'Left out');
      await queryClient.invalidateQueries({ queryKey: ['assets', 'review'] });
      await queryClient.invalidateQueries({ queryKey: ['timeline'] });
      await queryClient.invalidateQueries({ queryKey: ['me', 'storage'] });
    } catch (caught) {
      setHiding((current) => {
        const next = new Set(current);
        for (const id of ids) if (!done.has(id)) next.delete(id);
        return next;
      });
      if (done.size > 0) {
        await queryClient.invalidateQueries({ queryKey: ['assets', 'review'] });
        await queryClient.invalidateQueries({ queryKey: ['timeline'] });
        await queryClient.invalidateQueries({ queryKey: ['me', 'storage'] });
      }
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  async function keepAll() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await api('assets.acceptAllReview');
      setSelected(new Set());
      setConfirmKeepAll(false);
      announce('Kept all');
      await queryClient.invalidateQueries({ queryKey: ['assets', 'review'] });
      await queryClient.invalidateQueries({ queryKey: ['timeline'] });
      await queryClient.invalidateQueries({ queryKey: ['me', 'storage'] });
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  function selectAll() {
    if (busy) return;
    setMode('grid');
    try {
      localStorage.setItem(MODE_KEY, 'grid');
    } catch {
      // The choice still applies for this visit.
    }
    setSelected(new Set(items.map((item) => item.id)));
  }

  const current = items[0] ?? null;
  const allSelected = items.length > 0 && items.every((item) => selected.has(item.id));
  const totalBytes = review.data?.pages[0]?.totalBytes ?? 0;
  const leftLabel = review.isPending
    ? 'Checking…'
    : `${total === 1 ? '1 left' : `${total.toLocaleString()} left`} · ${formatBytes(totalBytes)}`;

  return (
    <Page
      wide={mode === 'grid'}
      title="Review"
      lede="Photos that didn't match anyone you marked Important. Keeping one adds it. Saying no deletes it from the server."
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">{leftLabel}</p>
        <div className="flex flex-wrap gap-1">
          {total > 0 ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => setConfirmKeepAll(true)}
            >
              Keep all
            </Button>
          ) : null}
          {items.length > 0 ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busy || allSelected}
              onClick={selectAll}
            >
              {allSelected ? 'All selected' : 'Select all'}
            </Button>
          ) : null}
          <Button
            type="button"
            size="sm"
            variant={mode === 'swipe' ? 'default' : 'ghost'}
            onClick={() => remember('swipe')}
          >
            Swipe
          </Button>
          <Button
            type="button"
            size="sm"
            variant={mode === 'grid' ? 'default' : 'ghost'}
            onClick={() => remember('grid')}
          >
            Select
          </Button>
        </div>
      </div>
      {review.isPending ? <LoadingBlock label="Loading photos" /> : null}
      {review.isError ? <ErrorState error={review.error} /> : null}
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      {review.data && items.length === 0 && !review.hasNextPage ? (
        <EmptyState title="Nothing waiting" body="New photos from other folders show up here." />
      ) : null}
      {mode === 'swipe' && current ? (
        <SwipeCard
          asset={current}
          busy={busy}
          onKeep={() => void decide([current.id], 'keep')}
          onNo={() => void decide([current.id], 'no')}
        />
      ) : null}
      {mode === 'grid' && items.length > 0 ? (
        <>
          <PhotoGrid
            assets={items}
            selecting
            selectedIds={selected}
            onOpen={(id) =>
              setSelected((currentIds) => {
                const next = new Set(currentIds);
                if (next.has(id)) next.delete(id);
                else next.add(id);
                return next;
              })
            }
            onToggle={(id) =>
              setSelected((currentIds) => {
                const next = new Set(currentIds);
                if (next.has(id)) next.delete(id);
                else next.add(id);
                return next;
              })
            }
            onHold={(id) => setSelected((currentIds) => new Set(currentIds).add(id))}
          />
          {selected.size > 0 ? (
            <SelectionBar
              count={selected.size}
              onClear={() => setSelected(new Set())}
              onSelectAll={selectAll}
            >
              <Button
                type="button"
                size="sm"
                disabled={busy}
                onClick={() => void decide([...selected], 'keep')}
              >
                Keep
              </Button>
              <Button
                type="button"
                size="sm"
                variant="destructive"
                disabled={busy}
                onClick={() => void decide([...selected], 'no')}
              >
                No
              </Button>
            </SelectionBar>
          ) : (
            <p className="text-sm text-muted-foreground">
              Select all covers this batch. Uncheck any you want to handle separately, then Keep or
              No. Load more brings the next batch.
            </p>
          )}
        </>
      ) : null}
      <Dialog open={confirmKeepAll} onOpenChange={setConfirmKeepAll}>
        <DialogContent>
          <DialogTitle>Keep every waiting photo?</DialogTitle>
          <DialogDescription>
            This adds all {total.toLocaleString()} photos ({formatBytes(totalBytes)}) to your
            library, including ones that are not loaded on this page.
          </DialogDescription>
          <div className="mt-6 flex justify-end gap-2">
            <DialogClose asChild>
              <Button type="button" variant="outline" disabled={busy}>
                Cancel
              </Button>
            </DialogClose>
            <Button type="button" pending={busy} onClick={() => void keepAll()}>
              {busy ? 'Keeping…' : 'Keep all'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      {review.hasNextPage ? (
        <Button
          type="button"
          variant="outline"
          disabled={review.isFetchingNextPage}
          onClick={() => void review.fetchNextPage()}
        >
          {review.isFetchingNextPage ? 'Loading…' : 'Load more'}
        </Button>
      ) : null}
    </Page>
  );
}

function SwipeCard({
  asset,
  busy,
  onKeep,
  onNo,
}: {
  asset: AssetSummary;
  busy: boolean;
  onKeep: () => void;
  onNo: () => void;
}) {
  const swipe = useDecisionSwipe(onKeep, onNo);
  const src = assetUrl(asset.previewUrl ?? asset.thumbnailUrl);
  const label = asset.localDate ?? 'Photo';

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target;
      if (target instanceof HTMLElement && target.closest('input, textarea, select, button'))
        return;
      if (event.key === 'ArrowRight') {
        event.preventDefault();
        onKeep();
      } else if (event.key === 'ArrowLeft') {
        event.preventDefault();
        onNo();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onKeep, onNo]);

  return (
    <div className="flex flex-col gap-4">
      <div
        className="relative flex min-h-80 touch-pan-y items-center justify-center overflow-hidden rounded-xl bg-card select-none"
        style={{ transform: swipe.dragX === 0 ? undefined : `translateX(${swipe.dragX}px)` }}
        {...swipe.handlers}
      >
        {src ? (
          <img
            src={src}
            alt={label}
            className="max-h-[70vh] w-full object-contain"
            draggable={false}
          />
        ) : (
          <p className="text-sm text-muted-foreground">{label}</p>
        )}
      </div>
      <p className="text-center text-sm text-muted-foreground">
        Swipe right to keep, left to say no.
      </p>
      <div className="flex justify-center gap-3">
        <Button type="button" variant="destructive" disabled={busy} onClick={onNo}>
          No
        </Button>
        <Button type="button" disabled={busy} onClick={onKeep}>
          Keep
        </Button>
      </div>
    </div>
  );
}

/** Right keeps the photo. Left deletes it. This is not the library viewer's previous/next swipe. */
function useDecisionSwipe(onKeep: () => void, onNo: () => void) {
  const start = useRef<{ x: number; y: number } | null>(null);
  const [dragX, setDragX] = useState(0);

  function onPointerDown(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    start.current = { x: event.clientX, y: event.clientY };
  }

  function onPointerMove(event: PointerEvent<HTMLDivElement>) {
    if (!start.current) return;
    const dx = event.clientX - start.current.x;
    const dy = event.clientY - start.current.y;
    if (Math.abs(dx) <= Math.abs(dy)) return;
    setDragX(dx);
  }

  function finish(event: PointerEvent<HTMLDivElement>) {
    if (!start.current) return;
    const dx = event.clientX - start.current.x;
    const dy = event.clientY - start.current.y;
    start.current = null;
    setDragX(0);
    if (Math.abs(dx) < 56 || Math.abs(dx) < Math.abs(dy)) return;
    if (dx > 0) onKeep();
    else onNo();
  }

  return {
    dragX,
    handlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp: finish,
      onPointerCancel: () => {
        start.current = null;
        setDragX(0);
      },
    },
  };
}
