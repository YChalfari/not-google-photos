import { Heart, ImagePlus, Play } from 'lucide-react';
import { thumbHashToDataURL } from 'thumbhash';
import type { AssetSummary } from '@ngp/shared';
import { cn } from '@/lib/utils';

function placeholder(thumbhash: string | null): string | undefined {
  if (!thumbhash) return undefined;
  try {
    const bytes = Uint8Array.from(atob(thumbhash), (char) => char.charCodeAt(0));
    return thumbHashToDataURL(bytes);
  } catch {
    return undefined;
  }
}

export function PhotoGrid({
  assets,
  onOpen,
  mainAssetId = null,
  onMakeMain,
}: {
  assets: readonly AssetSummary[];
  onOpen: (id: string) => void;
  /** Photo currently used as this person's picture. */
  mainAssetId?: string | null;
  onMakeMain?: (assetId: string) => void;
}) {
  return (
    <div className="grid grid-cols-3 gap-1 sm:grid-cols-4 md:grid-cols-6">
      {assets.map((asset) => {
        const src = asset.thumbnailUrl ?? placeholder(asset.thumbhash);
        const isMain = asset.id === mainAssetId;
        return (
          <div
            key={asset.id}
            className={cn(
              'group relative aspect-square overflow-hidden rounded-md bg-secondary',
              isMain && 'ring-2 ring-primary',
            )}
          >
            <button
              type="button"
              onClick={() => onOpen(asset.id)}
              aria-label={asset.localDate ?? (asset.type === 'video' ? 'Video' : 'Photo')}
              className="absolute inset-0"
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
                <Heart className="absolute top-1.5 left-1.5 size-4 fill-white text-white drop-shadow" />
              ) : null}
            </button>
            {onMakeMain ? (
              <button
                type="button"
                aria-pressed={isMain}
                aria-label={isMain ? 'Main photo' : 'Use as main photo'}
                className={cn(
                  'absolute top-1.5 right-1.5 z-10 rounded px-1.5 py-0.5 text-xs text-white',
                  isMain ? 'bg-primary' : 'bg-[#1c1915]/75',
                )}
                onClick={() => onMakeMain(asset.id)}
              >
                {isMain ? 'Main' : 'Make main'}
              </button>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
