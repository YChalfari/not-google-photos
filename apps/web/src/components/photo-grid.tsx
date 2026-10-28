import { Check, Heart, ImagePlus, Play } from 'lucide-react';
import { useRef } from 'react';
import { thumbHashToDataURL } from 'thumbhash';
import type { AssetSummary } from '@ngp/shared';
import { assetUrl } from '@/lib/native';
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
  selecting = false,
  selectedIds,
  onToggle,
  onHold,
}: {
  assets: readonly AssetSummary[];
  onOpen: (id: string) => void;
  selecting?: boolean;
  selectedIds?: ReadonlySet<string>;
  onToggle?: (id: string) => void;
  /** Press and hold starts a selection with this photo. */
  onHold?: (id: string) => void;
}) {
  return (
    <div className="grid grid-cols-3 gap-1 sm:grid-cols-4 md:grid-cols-6">
      {assets.map((asset) => (
        <PhotoTile
          key={asset.id}
          asset={asset}
          selecting={selecting}
          selected={selectedIds?.has(asset.id) ?? false}
          onOpen={onOpen}
          onToggle={onToggle}
          onHold={onHold}
        />
      ))}
    </div>
  );
}

function PhotoTile({
  asset,
  selecting,
  selected,
  onOpen,
  onToggle,
  onHold,
}: {
  asset: AssetSummary;
  selecting: boolean;
  selected: boolean;
  onOpen: (id: string) => void;
  onToggle?: (id: string) => void;
  onHold?: (id: string) => void;
}) {
  const timer = useRef<number | null>(null);
  const suppressClick = useRef(false);
  const src = assetUrl(asset.thumbnailUrl) ?? placeholder(asset.thumbhash);

  function cancelHold() {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
  }

  return (
    <button
      type="button"
      aria-label={asset.localDate ?? (asset.type === 'video' ? 'Video' : 'Photo')}
      aria-pressed={selecting ? selected : undefined}
      className={cn(
        'group relative aspect-square overflow-hidden rounded-md bg-secondary transition select-none active:scale-[0.98] active:brightness-75',
        selected && 'ring-2 ring-primary',
      )}
      onContextMenu={(event) => event.preventDefault()}
      onPointerDown={() => {
        if (!onHold) return;
        cancelHold();
        timer.current = window.setTimeout(() => {
          suppressClick.current = true;
          onHold(asset.id);
        }, 450);
      }}
      onPointerUp={cancelHold}
      onPointerLeave={cancelHold}
      onPointerCancel={cancelHold}
      onClick={() => {
        if (suppressClick.current) {
          suppressClick.current = false;
          return;
        }
        if (selecting) onToggle?.(asset.id);
        else onOpen(asset.id);
      }}
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
      {selecting ? (
        <span
          className={cn(
            'absolute top-1.5 right-1.5 grid size-5 place-items-center rounded-full border',
            selected
              ? 'border-primary bg-primary text-primary-foreground'
              : 'border-white/80 bg-black/35 text-transparent',
          )}
        >
          <Check className="size-3" />
        </span>
      ) : null}
    </button>
  );
}
