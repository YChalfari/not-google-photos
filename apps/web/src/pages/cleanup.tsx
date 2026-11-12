import type { CleanupFilter } from '@ngp/shared';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { PhotoGrid } from '@/components/photo-grid';
import { SelectionBar } from '@/components/selection-bar';
import { EmptyState, ErrorState, LoadingBlock, Page } from '@/components/states';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';
import { api, errorMessage } from '@/lib/api';
import { formatBytes } from '@/lib/format';
import { useStatus } from '@/lib/status';

const FILTERS: Array<{ id: CleanupFilter; label: string }> = [
  { id: 'screenshots', label: 'Screenshots' },
  { id: 'unimportant', label: 'Not important' },
  { id: 'rare', label: 'Few appearances' },
];

const TRASH_BATCH = 1000;

export function CleanupPage() {
  const queryClient = useQueryClient();
  const announce = useStatus();
  const [filter, setFilter] = useState<CleanupFilter | null>(null);
  const [maxFaces, setMaxFaces] = useState(3);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmAll, setConfirmAll] = useState(false);
  const matches = useInfiniteQuery({
    queryKey: ['assets', 'cleanup', filter, maxFaces],
    enabled: filter !== null,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      api('assets.cleanup', {
        query: {
          filter: filter ?? 'screenshots',
          maxFaces,
          limit: 100,
          ...(pageParam ? { cursor: pageParam } : {}),
        },
      }),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const items = matches.data?.pages.flatMap((page) => page.items) ?? [];
  const total = matches.data?.pages[0]?.total ?? 0;
  const totalBytes = matches.data?.pages[0]?.totalBytes ?? 0;
  const allSelected = items.length > 0 && items.every((item) => selected.has(item.id));

  function choose(next: CleanupFilter) {
    setFilter(next);
    setSelected(new Set());
    setError(null);
  }

  async function trash(ids: string[]) {
    if (ids.length === 0 || busy) return;
    setBusy(true);
    setError(null);
    try {
      for (let index = 0; index < ids.length; index += TRASH_BATCH) {
        await api('assets.update', {
          body: { ids: ids.slice(index, index + TRASH_BATCH), isTrashed: true },
        });
      }
      setSelected(new Set());
      announce(ids.length === 1 ? 'Moved to trash' : `Moved ${ids.length} to trash`);
      await queryClient.invalidateQueries({ queryKey: ['assets', 'cleanup'] });
      await queryClient.invalidateQueries({ queryKey: ['timeline'] });
      await queryClient.invalidateQueries({ queryKey: ['me', 'storage'] });
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  async function trashAll() {
    if (!filter || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api('assets.cleanupTrash', { body: { filter, maxFaces } });
      setSelected(new Set());
      setConfirmAll(false);
      announce(`Moved ${result.updated} to trash`);
      await queryClient.invalidateQueries({ queryKey: ['assets', 'cleanup'] });
      await queryClient.invalidateQueries({ queryKey: ['timeline'] });
      await queryClient.invalidateQueries({ queryKey: ['me', 'storage'] });
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Page
      wide
      title="Clean up"
      lede="Look through the library and move photos to the trash. Favorites are left out. Trash keeps them for 30 days."
    >
      <p>
        <Link to="/" className="text-sm text-primary underline-offset-4 hover:underline">
          Library
        </Link>
      </p>
      <div className="flex flex-wrap gap-2">
        {FILTERS.map((item) => (
          <Button
            key={item.id}
            type="button"
            size="sm"
            variant={filter === item.id ? 'default' : 'outline'}
            onClick={() => choose(item.id)}
          >
            {item.label}
          </Button>
        ))}
      </div>
      {filter === 'rare' ? (
        <label className="flex items-center gap-3 text-sm">
          At most
          <input
            type="number"
            min={1}
            max={100}
            value={maxFaces}
            aria-label="Maximum faces"
            className="h-10 w-20 rounded-md border border-input bg-card px-3 text-sm"
            onChange={(event) => {
              const next = Number(event.target.value);
              if (Number.isInteger(next) && next >= 1 && next <= 100) {
                setMaxFaces(next);
                setSelected(new Set());
              }
            }}
          />
          faces, named or not
        </label>
      ) : null}
      {filter === 'unimportant' ? (
        <p className="text-sm text-muted-foreground">
          Photos of people you have not marked Important, and of nobody who is.
        </p>
      ) : null}
      {filter === 'screenshots' ? (
        <p className="text-sm text-muted-foreground">Photos whose file name says screenshot.</p>
      ) : null}
      {filter ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-muted-foreground">
            {matches.isPending
              ? 'Checking…'
              : `${total === 1 ? '1 photo' : `${total.toLocaleString()} photos`} · ${formatBytes(totalBytes)}`}
          </p>
          <div className="flex flex-wrap gap-1">
            {items.length > 0 ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={busy || allSelected}
                onClick={() => setSelected(new Set(items.map((item) => item.id)))}
              >
                {allSelected ? 'All selected' : 'Select all'}
              </Button>
            ) : null}
            {total > 0 ? (
              <Button
                type="button"
                size="sm"
                variant="destructive"
                disabled={busy}
                onClick={() => setConfirmAll(true)}
              >
                Trash all
              </Button>
            ) : null}
          </div>
        </div>
      ) : (
        <EmptyState
          title="Choose a filter"
          body="Screenshots, people who aren't Important, or people who barely show up."
        />
      )}
      {matches.isPending && filter ? <LoadingBlock label="Loading photos" /> : null}
      {matches.isError ? <ErrorState error={matches.error} /> : null}
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      {filter && matches.data && items.length === 0 && !matches.hasNextPage ? (
        <EmptyState title="Nothing here" body="Nothing in the library matches this filter." />
      ) : null}
      {items.length > 0 ? (
        <>
          <PhotoGrid
            assets={items}
            selecting
            selectedIds={selected}
            onOpen={(id) =>
              setSelected((current) => {
                const next = new Set(current);
                if (next.has(id)) next.delete(id);
                else next.add(id);
                return next;
              })
            }
            onToggle={(id) =>
              setSelected((current) => {
                const next = new Set(current);
                if (next.has(id)) next.delete(id);
                else next.add(id);
                return next;
              })
            }
            onHold={(id) => setSelected((current) => new Set(current).add(id))}
          />
          {selected.size > 0 ? (
            <SelectionBar count={selected.size} onClear={() => setSelected(new Set())}>
              <Button
                type="button"
                size="sm"
                variant="destructive"
                disabled={busy}
                onClick={() => void trash([...selected])}
              >
                Trash
              </Button>
            </SelectionBar>
          ) : (
            <p className="text-sm text-muted-foreground">
              Select all covers this batch. Trash all moves every match, including ones not loaded.
            </p>
          )}
        </>
      ) : null}
      {matches.hasNextPage ? (
        <Button
          type="button"
          variant="outline"
          disabled={matches.isFetchingNextPage}
          onClick={() => void matches.fetchNextPage()}
        >
          {matches.isFetchingNextPage ? 'Loading…' : 'Load more'}
        </Button>
      ) : null}
      <Dialog open={confirmAll} onOpenChange={setConfirmAll}>
        <DialogContent>
          <DialogTitle>Move every match to the trash?</DialogTitle>
          <DialogDescription>
            This moves all {total.toLocaleString()} matching photos ({formatBytes(totalBytes)}) to
            the trash, including ones that are not loaded on this page. Favorites stay. You can
            restore them for 30 days.
          </DialogDescription>
          <div className="mt-6 flex justify-end gap-2">
            <DialogClose asChild>
              <Button type="button" variant="outline" disabled={busy}>
                Cancel
              </Button>
            </DialogClose>
            <Button
              type="button"
              variant="destructive"
              pending={busy}
              onClick={() => void trashAll()}
            >
              {busy ? 'Moving…' : 'Trash all'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </Page>
  );
}
