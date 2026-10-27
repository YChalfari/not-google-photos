import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { TimelineScope } from '@ngp/shared';
import { Heart, ImagePlus, Play } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { thumbHashToDataURL } from 'thumbhash';
import { AssetDialog } from '@/components/asset-dialog';
import { EmptyState, ErrorState, LoadingBlock, Page } from '@/components/states';
import { Button } from '@/components/ui/button';
import { api, errorMessage } from '@/lib/api';
import { useAssetParam } from '@/lib/asset-route';
import { assetUrl } from '@/lib/native';
import { formatBytes, formatMonth } from '@/lib/format';
import { uploadAsset } from '@/lib/upload';
import { cn } from '@/lib/utils';
import { useSession } from '@/session-context';

const SCOPES: Array<{ id: TimelineScope; label: string }> = [
  { id: 'library', label: 'Library' },
  { id: 'favorites', label: 'Favorites' },
  { id: 'archive', label: 'Archive' },
  { id: 'trash', label: 'Trash' },
];

function placeholder(thumbhash: string | null): string | undefined {
  if (!thumbhash) return undefined;
  try {
    const bytes = Uint8Array.from(atob(thumbhash), (char) => char.charCodeAt(0));
    return thumbHashToDataURL(bytes);
  } catch {
    return undefined;
  }
}

export function LibraryPage() {
  const { me } = useSession();
  const queryClient = useQueryClient();
  const [params, setParams] = useSearchParams();
  const requested = params.get('scope');
  const scope: TimelineScope = SCOPES.some((item) => item.id === requested)
    ? (requested as TimelineScope)
    : 'library';
  const viewer = useAssetParam();
  const [uploadLabel, setUploadLabel] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  const storage = useQuery({ queryKey: ['me', 'storage'], queryFn: () => api('me.storage') });
  const buckets = useQuery({
    queryKey: ['timeline', 'buckets', scope],
    queryFn: () => api('timeline.buckets', { query: { scope, withShared: 'true' } }),
  });
  const swipeIds = useLibrarySwipeIds(scope, buckets.data?.buckets, viewer.assetId);

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
    <Page
      wide
      title={me ? `${me.user.name}'s library` : 'Library'}
      lede="Photos you add here stay on this machine. Months load as you scroll."
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-1">
          {SCOPES.map((item) => (
            <Button
              key={item.id}
              size="sm"
              variant={scope === item.id ? 'default' : 'ghost'}
              onClick={() => setParams(item.id === 'library' ? {} : { scope: item.id })}
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
        </div>
      </div>

      {uploadError ? (
        <ErrorState title="Couldn't add that file" error={new Error(uploadError)} />
      ) : null}
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
              ? 'Add photos from this computer, or pair a phone from Settings. They stay on this machine.'
              : 'Photos you favorite, archive, or trash show up in these views.'
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
          onOpen={viewer.open}
        />
      ))}
      <AssetDialog
        assetId={viewer.assetId}
        ids={swipeIds}
        onClose={viewer.close}
        onNeighbor={viewer.select}
      />
    </Page>
  );
}

function Month({
  monthKey,
  count,
  scope,
  onOpen,
}: {
  monthKey: string;
  count: number;
  scope: TimelineScope;
  onOpen: (id: string) => void;
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
        <div className="grid grid-cols-3 gap-1 sm:grid-cols-4 md:grid-cols-6">
          {photos.data.assets.map((asset) => {
            const src = assetUrl(asset.thumbnailUrl) ?? placeholder(asset.thumbhash);
            return (
              <button
                key={asset.id}
                type="button"
                onClick={() => onOpen(asset.id)}
                aria-label={asset.localDate ?? (asset.type === 'video' ? 'Video' : 'Photo')}
                className="group relative aspect-square overflow-hidden rounded-md bg-secondary"
              >
                {src ? (
                  <img src={src} alt="" className="h-full w-full object-cover" />
                ) : (
                  <span className="flex h-full items-center justify-center text-muted-foreground">
                    <ImagePlus className="size-5" />
                  </span>
                )}
                {asset.type === 'video' ? (
                  <Play className="absolute right-1.5 bottom-1.5 size-4 fill-white text-white drop-shadow" />
                ) : null}
                {asset.isFavorite ? (
                  <Heart
                    className={cn(
                      'absolute top-1.5 left-1.5 size-4 fill-white text-white drop-shadow',
                    )}
                  />
                ) : null}
              </button>
            );
          })}
        </div>
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
      queryClient.getQueryData<{ assets: { id: string }[] }>([
        'timeline',
        'month',
        scope,
        key,
      ]) ?? null,
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
