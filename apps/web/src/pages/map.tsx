import { useQuery } from '@tanstack/react-query';
import { LocateFixed, Minus, Plus } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { AssetDialog } from '@/components/asset-dialog';
import { ErrorState } from '@/components/states';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';
import { useAssetParam } from '@/lib/asset-route';
import { loadBasemap } from '@/map/geometry';
import { PhotoMap } from '@/map/photo-map';
import { cn } from '@/lib/utils';

const frameClass = cn(
  'relative -mx-4 -mt-2 -mb-8 h-[calc(100dvh-max(1rem,env(safe-area-inset-top))-7.5rem)] min-h-80 w-[calc(100%+2rem)] overflow-hidden bg-[var(--map-ocean)] select-none',
  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring',
  'md:mx-0 md:mt-0 md:mb-0 md:h-[calc(100dvh-4rem)] md:w-full md:rounded-xl md:border md:border-border',
);

export function MapPage() {
  const viewer = useAssetParam();
  const openPhoto = useRef(viewer.open);
  useEffect(() => {
    openPhoto.current = viewer.open;
  }, [viewer.open]);
  const frame = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const map = useRef<PhotoMap | null>(null);
  const [openIds, setOpenIds] = useState<string[]>([]);
  const [limits, setLimits] = useState({ zoomIn: true, zoomOut: true });
  const points = useQuery({ queryKey: ['map'], queryFn: () => api('map.points') });
  const basemap = useQuery({
    queryKey: ['map', 'basemap'],
    queryFn: loadBasemap,
    staleTime: Infinity,
  });

  const photos = points.data?.points;
  const ready = Boolean(photos && photos.length > 0 && basemap.data);

  useEffect(() => {
    const node = canvas.current;
    const shapes = basemap.data;
    if (!node || !photos || photos.length === 0 || !shapes) return;
    const box = frame.current;
    if (!box) return;
    const photoMap = new PhotoMap(
      node,
      box,
      shapes,
      photos,
      (ids) => {
        const id = ids[0];
        if (!id) return;
        setOpenIds(ids);
        openPhoto.current(id);
      },
      setLimits,
    );
    map.current = photoMap;
    return () => {
      photoMap.destroy();
      map.current = null;
    };
  }, [basemap.data, photos]);

  const pending = points.isPending || (Boolean(photos?.length) && basemap.isPending);
  const failed = points.isError || basemap.isError;

  return (
    <>
      <div
        ref={frame}
        className={frameClass}
        tabIndex={ready ? 0 : undefined}
        role={ready ? 'application' : undefined}
        aria-label={ready ? 'Map of your photos' : undefined}
        aria-describedby={ready ? 'map-help' : undefined}
        onPointerDown={(event) => {
          if (event.target instanceof Element && event.target.closest('button')) return;
          frame.current?.focus({ preventScroll: true });
        }}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget) return;
          map.current?.onKey(event);
        }}
      >
        {ready ? null : <h1 className="sr-only">Map</h1>}
        <p id="map-help" className="sr-only">
          Drag to move. Pinch, scroll, or use the plus and minus buttons to zoom. Double-tap to zoom
          in. Arrow keys move the map.
        </p>
        {ready ? (
          <canvas
            ref={canvas}
            className="absolute inset-0 h-full w-full cursor-grab touch-none"
            aria-hidden="true"
          />
        ) : (
          <div className="grid h-full place-items-center px-6 text-center">
            {pending ? (
              <p className="text-sm text-foreground" role="status">
                Loading the map
              </p>
            ) : null}
            {failed ? (
              <ErrorState
                title="Couldn't load the map"
                error={points.error ?? basemap.error}
                onRetry={() => {
                  void points.refetch();
                  void basemap.refetch();
                }}
              />
            ) : null}
            {photos && photos.length === 0 ? (
              <p className="text-sm text-foreground">No photos with a location yet.</p>
            ) : null}
          </div>
        )}
        {ready ? (
          <>
            <h1 className="pointer-events-none absolute top-3 left-3 rounded-full bg-card/90 px-3 py-1 font-serif text-lg font-medium text-card-foreground shadow-sm backdrop-blur">
              Map
            </h1>
            <div className="absolute right-3 bottom-3 z-10 flex flex-col gap-2">
              <div className="flex flex-col overflow-hidden rounded-lg border border-border bg-card/95 shadow-md backdrop-blur">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-11 rounded-none"
                  aria-label="Zoom in"
                  disabled={!limits.zoomIn}
                  onClick={() => map.current?.zoomIn()}
                >
                  <Plus />
                </Button>
                <div className="h-px bg-border" />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-11 rounded-none"
                  aria-label="Zoom out"
                  disabled={!limits.zoomOut}
                  onClick={() => map.current?.zoomOut()}
                >
                  <Minus />
                </Button>
              </div>
              <Button
                type="button"
                variant="outline"
                size="icon"
                className="size-11 bg-card/95 shadow-md backdrop-blur"
                aria-label="Show your photos"
                onClick={() => map.current?.showPhotos()}
              >
                <LocateFixed />
              </Button>
            </div>
          </>
        ) : null}
      </div>
      <AssetDialog
        assetId={viewer.assetId}
        ids={openIds}
        onClose={viewer.close}
        onNeighbor={viewer.select}
      />
    </>
  );
}
