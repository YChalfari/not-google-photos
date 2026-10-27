import { Heart, ImagePlus, Play } from 'lucide-react';
import { thumbHashToDataURL } from 'thumbhash';
import type { AssetSummary } from '@ngp/shared';
import { assetUrl } from '@/lib/native';

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
}: {
  assets: readonly AssetSummary[];
  onOpen: (id: string) => void;
}) {
  return (
    <div className="grid grid-cols-3 gap-1 sm:grid-cols-4 md:grid-cols-6">
      {assets.map((asset) => {
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
              <Heart className="absolute top-1.5 left-1.5 size-4 fill-white text-white drop-shadow" />
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
