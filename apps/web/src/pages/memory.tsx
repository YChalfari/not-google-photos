import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { AssetDialog } from '@/components/asset-dialog';
import { PhotoGrid } from '@/components/photo-grid';
import { EmptyState, ErrorState, LoadingBlock, Page } from '@/components/states';
import { useStatus } from '@/lib/status';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';
import { useAssetParam } from '@/lib/asset-route';

export function MemoryPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const announce = useStatus();
  const viewer = useAssetParam();
  const marked = useRef(false);
  const memory = useQuery({
    queryKey: ['memories', id],
    queryFn: () => api('memories.get', { params: { id } }),
    enabled: id.length > 0,
  });
  const dismiss = useMutation({
    mutationFn: () => api('memories.update', { params: { id }, body: { dismissed: true } }),
    onSuccess: async () => {
      announce('Dismissed');
      await queryClient.invalidateQueries({ queryKey: ['memories'] });
      void navigate('/');
    },
  });

  useEffect(() => {
    if (!memory.data || memory.data.memory.seenAt || marked.current) return;
    marked.current = true;
    void api('memories.update', { params: { id }, body: { seen: true } }).then(() =>
      queryClient.invalidateQueries({ queryKey: ['memories', 'today'] }),
    );
  }, [id, memory.data, queryClient]);

  const detail = memory.data?.memory;

  return (
    <Page
      wide
      title={detail?.title ?? 'Memory'}
      lede={detail ? (detail.subtitle ?? undefined) : 'Photos from this day in earlier years.'}
    >
      <p>
        <Link to="/" className="text-sm text-primary underline-offset-4 hover:underline">
          Back to the library
        </Link>
      </p>
      {memory.isPending ? <LoadingBlock label="Loading memory" /> : null}
      {memory.isError ? (
        <ErrorState
          title="Couldn't load this memory"
          error={memory.error}
          onRetry={() => void memory.refetch()}
        />
      ) : null}
      {detail && detail.assets.length === 0 ? (
        <EmptyState
          title="Nothing left in this memory"
          body="The photos were removed from your library."
        />
      ) : null}
      {detail && detail.assets.length > 0 ? (
        <PhotoGrid assets={detail.assets} onOpen={viewer.open} />
      ) : null}
      {detail ? (
        <Button
          type="button"
          variant="outline"
          className="self-start"
          pending={dismiss.isPending}
          onClick={() => dismiss.mutate()}
        >
          {dismiss.isPending ? 'Dismissing…' : 'Dismiss'}
        </Button>
      ) : null}
      <AssetDialog
        assetId={viewer.assetId}
        ids={detail?.assets.map((asset) => asset.id) ?? []}
        onClose={viewer.close}
        onNeighbor={viewer.select}
      />
    </Page>
  );
}
