import { Check, Heart, ImagePlus, Play } from 'lucide-react';
import { useRef, type RefObject } from 'react';
import { thumbHashToDataURL } from 'thumbhash';
import type { AssetSummary } from '@ngp/shared';
import { assetUrl } from '@/lib/native';
import { useSlideSelect } from '@/lib/slide-select';
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
  const slide = useSlideSelect({
    enabled: selecting && Boolean(onToggle),
    isSelected: (id) => selectedIds?.has(id) ?? false,
    onToggle: (id) => onToggle?.(id),
  });
  return (
    <div
      ref={slide.ref}
      className={cn(
        'grid grid-cols-3 gap-1 select-none sm:grid-cols-4 md:grid-cols-6',
        selecting && onToggle && 'touch-pan-y',
      )}
      onPointerDown={slide.onPointerDown}
      onPointerMove={slide.onPointerMove}
      onPointerUp={slide.onPointerUp}
      onPointerCancel={slide.onPointerCancel}
      onLostPointerCapture={slide.onLostPointerCapture}
    >
      {assets.map((asset) => (
        <PhotoTile
          key={asset.id}
          asset={asset}
          selecting={selecting}
          selected={selectedIds?.has(asset.id) ?? false}
          onOpen={onOpen}
          onToggle={onToggle}
          onHold={onHold}
          ignoreClickRef={slide.ignoreClickRef}
          slideActiveRef={slide.activeRef}
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
  ignoreClickRef,
  slideActiveRef,
}: {
  asset: AssetSummary;
  selecting: boolean;
  selected: boolean;
  onOpen: (id: string) => void;
  onToggle?: (id: string) => void;
  onHold?: (id: string) => void;
  ignoreClickRef?: RefObject<boolean>;
  slideActiveRef?: RefObject<boolean>;
}) {
  const timer = useRef<number | null>(null);
  const suppressClick = useRef(false);
  const origin = useRef<{ x: number; y: number } | null>(null);
  const src = assetUrl(asset.thumbnailUrl) ?? placeholder(asset.thumbhash);

  function cancelHold() {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
  }

  return (
    <button
      type="button"
      data-select-id={selecting ? asset.id : undefined}
      aria-label={asset.localDate ?? (asset.type === 'video' ? 'Video' : 'Photo')}
      aria-pressed={selecting ? selected : undefined}
      className={cn(
        'group relative aspect-square overflow-hidden rounded-md bg-secondary transition select-none',
        !selecting && 'active:scale-[0.98] active:brightness-75',
        selected && 'ring-2 ring-primary',
      )}
      onContextMenu={(event) => event.preventDefault()}
      onDragStart={(event) => event.preventDefault()}
      onPointerDown={(event) => {
        origin.current = { x: event.clientX, y: event.clientY };
        if (!onHold) return;
        cancelHold();
        timer.current = window.setTimeout(() => {
          if (slideActiveRef?.current) return;
          suppressClick.current = true;
          onHold(asset.id);
        }, 450);
      }}
      onPointerMove={(event) => {
        const start = origin.current;
        if (!start) return;
        if (Math.hypot(event.clientX - start.x, event.clientY - start.y) >= 8) cancelHold();
      }}
      onPointerUp={cancelHold}
      onPointerLeave={cancelHold}
      onPointerCancel={cancelHold}
      onClick={() => {
        if (suppressClick.current || ignoreClickRef?.current) {
          suppressClick.current = false;
          if (ignoreClickRef) ignoreClickRef.current = false;
          return;
        }
        if (selecting) onToggle?.(asset.id);
        else onOpen(asset.id);
      }}
    >
      {src ? (
        <img
          src={src}
          alt=""
          draggable={false}
          className="pointer-events-none h-full w-full object-cover"
        />
      ) : (
        <span className="flex h-full items-center justify-center text-muted-foreground">
          <ImagePlus className="size-5" />
        </span>
      )}
      {asset.type === 'video' ? (
        <Play className="pointer-events-none absolute right-1.5 bottom-1.5 size-4 fill-white text-white drop-shadow" />
      ) : null}
      {asset.isFavorite ? (
        <Heart className="pointer-events-none absolute top-1.5 left-1.5 size-4 fill-white text-white drop-shadow" />
      ) : null}
      {selecting ? (
        <span
          className={cn(
            'pointer-events-none absolute top-1.5 right-1.5 grid size-5 place-items-center rounded-full border',
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
