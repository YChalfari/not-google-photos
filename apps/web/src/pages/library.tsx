import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { TimelineScope } from '@ngp/shared';
import { ImagePlus } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { AddToAlbumButton } from '@/components/add-to-album';
import { AssetDialog } from '@/components/asset-dialog';
import { PhotoGrid } from '@/components/photo-grid';
import { SelectionBar } from '@/components/selection-bar';
import { EmptyState, ErrorState, FormError, LoadingBlock, Page } from '@/components/states';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { api, errorMessage } from '@/lib/api';
import { useAssetParam } from '@/lib/asset-route';
import { useAssetBatch } from '@/lib/asset-batch';
import { formatBytes, formatMonth } from '@/lib/format';
import { assetUrl } from '@/lib/native';
import { uploadAsset } from '@/lib/upload';
import { ReviewWaitingLink } from '@/pages/review';
import { useStatus } from '@/lib/status';
import { useSession } from '@/session-context';

const SCOPES: Array<{ id: TimelineScope; label: string }> = [
  { id: 'library', label: 'Library' },
  { id: 'favorites', label: 'Favorites' },
  { id: 'archive', label: 'Archive' },
  { id: 'trash', label: 'Trash' },
];

export function LibraryPage() {
  const { me } = useSession();
  const queryClient = useQueryClient();
  const announce = useStatus();
  const [params, setParams] = useSearchParams();
  const requested = params.get('scope');
  const scope: TimelineScope = SCOPES.some((item) => item.id === requested)
    ? (requested as TimelineScope)
    : 'library';
  const viewer = useAssetParam();
  const [uploadLabel, setUploadLabel] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string> | null>(null);
  const [confirmEmpty, setConfirmEmpty] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const batch = useAssetBatch();
  const emptyTrash = useMutation({
    mutationFn: () => api('assets.emptyTrash'),
    onSuccess: async (result) => {
      setConfirmEmpty(false);
      announce(result.deleted === 0 ? 'Trash is empty' : 'Trash emptied');
      await queryClient.invalidateQueries({ queryKey: ['timeline'] });
      await queryClient.invalidateQueries({ queryKey: ['me', 'storage'] });
    },
  });

  const storage = useQuery({ queryKey: ['me', 'storage'], queryFn: () => api('me.storage') });
  const buckets = useQuery({
    queryKey: ['timeline', 'buckets', scope],
    queryFn: () => api('timeline.buckets', { query: { scope, withShared: 'true' } }),
  });
  const memories = useQuery({
    queryKey: ['memories', 'today'],
    queryFn: () => api('memories.list'),
    enabled: scope === 'library',
  });
  const swipeIds = useLibrarySwipeIds(scope, buckets.data?.buckets, viewer.assetId);

  useEffect(() => {
    if (!selected) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setSelected(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selected]);

  useEffect(() => {
    if (!refreshing) return;
    const refresh = setInterval(() => {
      void queryClient.invalidateQueries({ queryKey: ['timeline'] });
    }, 2000);
    const stop = setTimeout(() => setRefreshing(false), 15000);
    return () => {
      clearInterval(refresh);
      clearTimeout(stop);
    };
  }, [refreshing, queryClient]);

  async function onFiles(list: FileList | null) {
    if (!list || list.length === 0) return;
    setUploadError(null);
    const files = [...list];
    try {
      for (let index = 0; index < files.length; index += 1) {
        const file = files[index];
        if (!file) continue;
        setUploadLabel(`Uploading ${index + 1} of ${files.length}`);
        await uploadAsset(file);
      }
      await queryClient.invalidateQueries({ queryKey: ['timeline'] });
      await queryClient.invalidateQueries({ queryKey: ['me', 'storage'] });
      setRefreshing(true);
      if (scope !== 'library') setParams({});
    } catch (error) {
      setUploadError(errorMessage(error));
    } finally {
      setUploadLabel(null);
    }
  }

  const quota =
    storage.data?.quotaBytes == null ? null : `of ${formatBytes(storage.data.quotaBytes)}`;

  return (
    <Page wide title={me ? `${me.user.name}'s library` : 'Library'}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-1">
          {SCOPES.map((item) => (
            <Button
              key={item.id}
              size="sm"
              variant={scope === item.id ? 'default' : 'ghost'}
              onClick={() => {
                if (item.id !== scope) setSelected(null);
                setParams(item.id === 'library' ? {} : { scope: item.id });
              }}
            >
              {item.label}
            </Button>
          ))}
        </div>
        <div className="flex items-center gap-3">
          {storage.data ? (
            <p className="text-sm text-muted-foreground">
              {storage.data.assetCount} {storage.data.assetCount === 1 ? 'item' : 'items'} ·{' '}
              {formatBytes(storage.data.usedBytes)}
              {quota ? ` ${quota}` : ''}
            </p>
          ) : null}
          <input
            ref={input}
            type="file"
            accept="image/*,video/*,.heic,.heif"
            multiple
            tabIndex={-1}
            aria-hidden
            className="sr-only"
            onChange={(event) => {
              void onFiles(event.target.files);
              event.target.value = '';
            }}
          />
          <Button onClick={() => input.current?.click()} disabled={uploadLabel !== null}>
            <ImagePlus />
            {uploadLabel ?? 'Add photos'}
          </Button>
          <Button
            type="button"
            variant={selected ? 'default' : 'outline'}
            onClick={() => setSelected(selected ? null : new Set())}
          >
            {selected ? 'Done' : 'Select'}
          </Button>
        </div>
      </div>
      {scope === 'library' ? <ReviewWaitingLink /> : null}
      {scope === 'trash' ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-muted-foreground">Kept for 30 days, then deleted.</p>
          <Dialog open={confirmEmpty} onOpenChange={setConfirmEmpty}>
            <DialogTrigger asChild>
              <Button
                type="button"
                size="sm"
                variant="destructive"
                disabled={!buckets.data || buckets.data.buckets.length === 0}
              >
                Empty trash
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogTitle>Empty trash?</DialogTitle>
              <DialogDescription>
                This deletes everything in the trash. It can't be undone.
              </DialogDescription>
              <div className="mt-6 flex justify-end gap-2">
                <DialogClose asChild>
                  <Button type="button" variant="outline">
                    Keep them
                  </Button>
                </DialogClose>
                <Button
                  type="button"
                  variant="destructive"
                  pending={emptyTrash.isPending}
                  onClick={() => emptyTrash.mutate()}
                >
                  {emptyTrash.isPending ? 'Deleting…' : 'Empty trash'}
                </Button>
              </div>
              <FormError error={emptyTrash.error} />
            </DialogContent>
          </Dialog>
        </div>
      ) : null}

      {uploadError ? (
        <ErrorState title="Couldn't add that file" error={new Error(uploadError)} />
      ) : null}
      {scope === 'library'
        ? memories.data?.memories
            .filter((memory) => memory.assetCount > 0)
            .map((memory) => (
              <Link
                key={memory.id}
                to={`/memories/${memory.id}`}
                className="flex items-center gap-4 rounded-xl border border-border bg-card p-3 active:brightness-90"
              >
                <span className="size-20 shrink-0 overflow-hidden rounded-lg bg-secondary">
                  {memory.coverUrl ? (
                    <img
                      src={assetUrl(memory.coverUrl)}
                      alt=""
                      className="h-full w-full object-cover"
                    />
                  ) : null}
                </span>
                <span>
                  <span className="block font-serif text-2xl">{memory.title}</span>
                  <span className="mt-1 block text-sm text-muted-foreground">
                    {memory.subtitle ? `${memory.subtitle} · ` : ''}
                    {memory.assetCount} {memory.assetCount === 1 ? 'photo' : 'photos'}
                  </span>
                </span>
              </Link>
            ))
        : null}
      {buckets.isPending ? <LoadingBlock label="Loading your library" /> : null}
      {buckets.isError ? (
        <ErrorState
          title="Couldn't load your library"
          error={buckets.error}
          onRetry={() => void buckets.refetch()}
        />
      ) : null}
      {buckets.data && buckets.data.buckets.length === 0 ? (
        <EmptyState
          title={scope === 'library' ? 'No photos yet' : `Nothing in ${scope}`}
          body={
            scope === 'library'
              ? 'Add some from this computer, or pair a phone in Settings.'
              : 'Nothing here yet.'
          }
          action={
            scope === 'library' ? (
              <Button asChild variant="outline">
                <Link to="/settings">Pair a phone</Link>
              </Button>
            ) : undefined
          }
        />
      ) : null}
      {buckets.data?.buckets.map((bucket) => (
        <Month
          key={`${scope}:${bucket.key}`}
          monthKey={bucket.key}
          count={bucket.count}
          scope={scope}
          selecting={selected !== null}
          selectedIds={selected ?? undefined}
          onOpen={viewer.open}
          onToggle={(id) =>
            setSelected((current) => {
              const next = new Set(current ?? []);
              if (next.has(id)) next.delete(id);
              else next.add(id);
              return next;
            })
          }
          onHold={(id) =>
            setSelected((current) => {
              const next = new Set(current ?? []);
              next.add(id);
              return next;
            })
          }
        />
      ))}
      <AssetDialog
        assetId={viewer.assetId}
        ids={swipeIds}
        onClose={viewer.close}
        onNeighbor={viewer.select}
      />
      {selected ? (
        <LibrarySelection
          scope={scope}
          ids={[...selected]}
          pending={batch.isPending}
          onClear={() => setSelected(null)}
          onFavorite={() => batch.mutate({ ids: [...selected], isFavorite: scope !== 'favorites' })}
          onArchive={() => batch.mutate({ ids: [...selected], isArchived: scope !== 'archive' })}
          onTrash={() =>
            batch.mutate(
              { ids: [...selected], isTrashed: scope !== 'trash' },
              { onSuccess: () => setSelected(null) },
            )
          }
        />
      ) : null}
    </Page>
  );
}

function LibrarySelection({
  scope,
  ids,
  pending,
  onClear,
  onFavorite,
  onArchive,
  onTrash,
}: {
  scope: TimelineScope;
  ids: string[];
  pending: boolean;
  onClear: () => void;
  onFavorite: () => void;
  onArchive: () => void;
  onTrash: () => void;
}) {
  const empty = ids.length === 0;
  return (
    <SelectionBar count={ids.length} onClear={onClear}>
      <Button
        type="button"
        size="sm"
        variant="outline"
        pending={pending}
        disabled={empty}
        onClick={onFavorite}
      >
        {scope === 'favorites' ? 'Unfavorite' : 'Favorite'}
      </Button>
      <Button
        type="button"
        size="sm"
        variant="outline"
        pending={pending}
        disabled={empty}
        onClick={onArchive}
      >
        {scope === 'archive' ? 'Unarchive' : 'Archive'}
      </Button>
      <Button
        type="button"
        size="sm"
        variant="outline"
        pending={pending}
        disabled={empty}
        onClick={onTrash}
      >
        {scope === 'trash' ? 'Restore' : 'Trash'}
      </Button>
      {scope === 'trash' ? null : <AddToAlbumButton ids={ids} disabled={pending || empty} />}
    </SelectionBar>
  );
}

function Month({
  monthKey,
  count,
  scope,
  selecting,
  selectedIds,
  onOpen,
  onToggle,
  onHold,
}: {
  monthKey: string;
  count: number;
  scope: TimelineScope;
  selecting: boolean;
  selectedIds?: ReadonlySet<string>;
  onOpen: (id: string) => void;
  onToggle: (id: string) => void;
  onHold: (id: string) => void;
}) {
  const ref = useRef<HTMLElement>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) setVisible(true);
      },
      { rootMargin: '500px' },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const photos = useQuery({
    queryKey: ['timeline', 'month', scope, monthKey],
    queryFn: () =>
      api('timeline.bucket', { params: { key: monthKey }, query: { scope, withShared: 'true' } }),
    enabled: visible,
  });

  return (
    <section ref={ref} className="flex flex-col gap-3">
      <header className="flex items-baseline justify-between">
        <h2 className="font-serif text-2xl">{formatMonth(monthKey)}</h2>
        <p className="text-sm text-muted-foreground">{count}</p>
      </header>
      {photos.isPending ? <div className="h-28 animate-pulse rounded-xl bg-secondary" /> : null}
      {photos.isError ? (
        <ErrorState
          title="Couldn't load this month"
          error={photos.error}
          onRetry={() => void photos.refetch()}
        />
      ) : null}
      {photos.data ? (
        <PhotoGrid
          assets={photos.data.assets}
          selecting={selecting}
          selectedIds={selectedIds}
          onOpen={onOpen}
          onToggle={onToggle}
          onHold={onHold}
        />
      ) : null}
    </section>
  );
}

function useLibrarySwipeIds(
  scope: TimelineScope,
  buckets: readonly { key: string }[] | undefined,
  assetId: string | null,
): string[] {
  const queryClient = useQueryClient();
  const keys = buckets?.map((bucket) => bucket.key) ?? [];
  const loaded = keys.map(
    (key) =>
      queryClient.getQueryData<{ assets: { id: string }[] }>(['timeline', 'month', scope, key]) ??
      null,
  );
  const bucketIndex = assetId
    ? loaded.findIndex((month) => month?.assets.some((asset) => asset.id === assetId))
    : -1;
  const neighborKey = (offset: number) =>
    bucketIndex >= 0 ? keys[bucketIndex + offset] : undefined;
  const previousKey = neighborKey(-1);
  const nextKey = neighborKey(1);

  useQuery({
    queryKey: ['timeline', 'month', scope, previousKey ?? ''],
    queryFn: () =>
      api('timeline.bucket', {
        params: { key: previousKey! },
        query: { scope, withShared: 'true' },
      }),
    enabled: Boolean(assetId && previousKey && !loaded[bucketIndex - 1]),
  });
  useQuery({
    queryKey: ['timeline', 'month', scope, nextKey ?? ''],
    queryFn: () =>
      api('timeline.bucket', {
        params: { key: nextKey! },
        query: { scope, withShared: 'true' },
      }),
    enabled: Boolean(assetId && nextKey && !loaded[bucketIndex + 1]),
  });

  return loaded.flatMap((month) => month?.assets.map((asset) => asset.id) ?? []);
}
