import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Heart, Trash2 } from 'lucide-react';
import { thumbHashToDataURL } from 'thumbhash';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { api } from '@/lib/api';
import { formatBytes, formatWhen } from '@/lib/format';

function placeholder(thumbhash: string | null): string | undefined {
  if (!thumbhash) return undefined;
  try {
    const bytes = Uint8Array.from(atob(thumbhash), (char) => char.charCodeAt(0));
    return thumbHashToDataURL(bytes);
  } catch {
    return undefined;
  }
}

export function AssetDialog({ assetId, onClose }: { assetId: string | null; onClose: () => void }) {
  const queryClient = useQueryClient();
  const detail = useQuery({
    queryKey: ['asset', assetId],
    queryFn: () => api('assets.get', { params: { id: assetId! } }),
    enabled: assetId !== null,
  });

  const update = useMutation({
    mutationFn: (body: { isFavorite?: boolean; isArchived?: boolean; isTrashed?: boolean }) =>
      api('assets.update', { body: { ids: [assetId!], ...body } }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['asset', assetId] });
      await queryClient.invalidateQueries({ queryKey: ['timeline'] });
    },
  });

  const asset = detail.data;
  const image = asset?.previewUrl ?? asset?.originalUrl ?? placeholder(asset?.thumbhash ?? null);

  return (
    <Dialog open={assetId !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="w-[min(100%-2rem,56rem)] p-0">
        <DialogTitle className="sr-only">{asset?.originalFilename ?? 'Photo'}</DialogTitle>
        <DialogDescription className="sr-only">
          {asset?.localDate ?? 'Photo details'}
        </DialogDescription>
        {detail.isPending ? <div className="h-80 animate-pulse bg-secondary" /> : null}
        {detail.isError ? (
          <p className="p-6 text-sm text-muted-foreground">This photo could not be opened.</p>
        ) : null}
        {asset ? (
          <div className="flex flex-col md:flex-row">
            <div className="flex min-h-64 flex-1 items-center justify-center bg-[#1c1915]">
              {asset.type === 'video' ? (
                <video
                  src={asset.playbackUrl ?? asset.originalUrl ?? undefined}
                  poster={image}
                  controls
                  className="max-h-[70vh] w-full"
                />
              ) : (
                <img src={image} alt="" className="max-h-[70vh] w-full object-contain" />
              )}
            </div>
            <div className="flex w-full flex-col gap-4 p-5 md:w-64">
              <div>
                <p className="font-medium break-words">{asset.originalFilename}</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  {formatWhen(asset.capturedAt)}
                  {asset.location?.city ? ` · ${asset.location.city}` : ''}
                </p>
                <p className="mt-1 text-sm text-muted-foreground">
                  {formatBytes(asset.sizeBytes)}
                  {asset.camera?.model ? ` · ${asset.camera.model}` : ''}
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  variant={asset.isFavorite ? 'default' : 'outline'}
                  size="sm"
                  disabled={update.isPending}
                  onClick={() => update.mutate({ isFavorite: !asset.isFavorite })}
                >
                  <Heart />
                  {asset.isFavorite ? 'Favorited' : 'Favorite'}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={update.isPending}
                  onClick={() => update.mutate({ isArchived: !asset.isArchived })}
                >
                  {asset.isArchived ? 'Unarchive' : 'Archive'}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={update.isPending}
                  onClick={() => {
                    update.mutate(
                      { isTrashed: asset.trashedAt === null },
                      { onSuccess: () => onClose() },
                    );
                  }}
                >
                  <Trash2 />
                  {asset.trashedAt ? 'Restore' : 'Trash'}
                </Button>
              </div>
              {asset.originalUrl ? (
                <a
                  className="text-sm text-primary underline-offset-4 hover:underline"
                  href={asset.originalUrl}
                >
                  Download original
                </a>
              ) : null}
            </div>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
