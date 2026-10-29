import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { AssetDialog } from '@/components/asset-dialog';
import { ErrorState, LoadingBlock, Page } from '@/components/states';
import { api } from '@/lib/api';
import { useAssetParam } from '@/lib/asset-route';
import land from '@/map/land.json' with { type: 'json' };

interface LandGeometry {
  type: string;
  coordinates: number[][][] | number[][][][];
}

const outline = land as unknown as {
  features: Array<{ geometry: LandGeometry }>;
};

interface Cluster {
  x: number;
  y: number;
  count: number;
  ids: string[];
}

function polygons(geometry: LandGeometry): number[][][][] {
  if (geometry.type === 'MultiPolygon') return geometry.coordinates as number[][][][];
  return [geometry.coordinates as number[][][]];
}

function project(
  longitude: number,
  latitude: number,
  width: number,
  height: number,
): [number, number] {
  return [((longitude + 180) / 360) * width, ((90 - latitude) / 180) * height];
}

function color(name: string, fallback: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

export function MapPage() {
  const viewer = useAssetParam();
  const canvas = useRef<HTMLCanvasElement>(null);
  const clusters = useRef<Cluster[]>([]);
  const [openIds, setOpenIds] = useState<string[]>([]);
  const points = useQuery({ queryKey: ['map'], queryFn: () => api('map.points') });

  useEffect(() => {
    const node = canvas.current;
    if (!node || !points.data) return;

    const draw = () => {
      const context = node.getContext('2d');
      if (!context) return;
      const rect = node.getBoundingClientRect();
      const ratio = window.devicePixelRatio || 1;
      const width = Math.max(1, rect.width);
      const height = Math.max(1, rect.height);
      node.width = Math.floor(width * ratio);
      node.height = Math.floor(height * ratio);
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.clearRect(0, 0, width, height);
      context.fillStyle = color('--background', '#161410');
      context.fillRect(0, 0, width, height);
      context.fillStyle = color('--muted', '#2c2823');
      context.beginPath();
      for (const feature of outline.features) {
        for (const polygon of polygons(feature.geometry)) {
          for (const ring of polygon) {
            ring.forEach((coord, index) => {
              const [x, y] = project(coord[0] ?? 0, coord[1] ?? 0, width, height);
              if (index === 0) context.moveTo(x, y);
              else context.lineTo(x, y);
            });
            context.closePath();
          }
        }
      }
      context.fill('evenodd');

      const groups = new Map<string, Cluster>();
      for (const point of points.data.points) {
        const [x, y] = project(point.longitude, point.latitude, width, height);
        const key = `${Math.round(x / 36)}:${Math.round(y / 36)}`;
        const group = groups.get(key);
        if (!group) {
          groups.set(key, { x, y, count: 1, ids: [point.id] });
          continue;
        }
        group.count += 1;
        group.x = (group.x * (group.count - 1) + x) / group.count;
        group.y = (group.y * (group.count - 1) + y) / group.count;
        if (group.ids.length < 40) group.ids.push(point.id);
      }
      clusters.current = [...groups.values()];
      context.fillStyle = color('--primary', '#3d9a6e');
      context.font = '12px sans-serif';
      context.textAlign = 'center';
      context.textBaseline = 'middle';
      for (const group of clusters.current) {
        const radius = group.count === 1 ? 5 : Math.min(18, 7 + Math.log2(group.count) * 2);
        context.beginPath();
        context.arc(group.x, group.y, radius, 0, Math.PI * 2);
        context.fill();
        if (group.count > 1) {
          context.fillStyle = color('--primary-foreground', '#f3efe6');
          context.fillText(String(group.count), group.x, group.y);
          context.fillStyle = color('--primary', '#3d9a6e');
        }
      }
    };

    draw();
    const observer = new ResizeObserver(draw);
    observer.observe(node);
    const theme = new MutationObserver(draw);
    theme.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => {
      observer.disconnect();
      theme.disconnect();
    };
  }, [points.data]);

  return (
    <Page wide title="Map">
      {points.isPending ? <LoadingBlock label="Loading the map" /> : null}
      {points.isError ? (
        <ErrorState
          title="Couldn't load the map"
          error={points.error}
          onRetry={() => void points.refetch()}
        />
      ) : null}
      {points.data && points.data.points.length === 0 ? (
        <p className="text-sm text-muted-foreground">No photos with a location yet.</p>
      ) : null}
      {points.data && points.data.points.length > 0 ? (
        <canvas
          ref={canvas}
          className="h-[70vh] min-h-80 w-full rounded-xl border border-border"
          role="img"
          aria-label="Map of your photos"
          onClick={(event) => {
            const rect = event.currentTarget.getBoundingClientRect();
            const x = event.clientX - rect.left;
            const y = event.clientY - rect.top;
            let nearest: Cluster | undefined;
            let best = 24;
            for (const group of clusters.current) {
              const distance = Math.hypot(group.x - x, group.y - y);
              if (distance < best) {
                best = distance;
                nearest = group;
              }
            }
            const id = nearest?.ids[0];
            if (!nearest || !id) return;
            setOpenIds(nearest.ids);
            viewer.open(id);
          }}
        />
      ) : null}
      <AssetDialog
        assetId={viewer.assetId}
        ids={openIds}
        onClose={viewer.close}
        onNeighbor={viewer.select}
      />
    </Page>
  );
}
