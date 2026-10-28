import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useStatus } from '@/lib/status';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { api, errorMessage } from '@/lib/api';

export function AddToAlbumButton({
  ids,
  disabled,
}: {
  ids: readonly string[];
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const announce = useStatus();
  const queryClient = useQueryClient();
  const albums = useQuery({
    queryKey: ['albums'],
    queryFn: () => api('albums.list'),
    enabled: open,
  });
  const add = useMutation({
    mutationFn: (albumId: string) =>
      api('albums.addAssets', { params: { id: albumId }, body: { assetIds: [...ids] } }),
    onSuccess: async (result, albumId) => {
      await queryClient.invalidateQueries({ queryKey: ['albums'] });
      const title = albums.data?.albums.find((album) => album.id === albumId)?.title ?? 'the album';
      announce(result.added === 0 ? `Already in ${title}` : `Added ${result.added} to ${title}`);
      setOpen(false);
    },
  });
  const choices = (albums.data?.albums ?? []).filter(
    (album) => !album.invited && (album.role === 'owner' || album.role === 'contributor'),
  );

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button type="button" size="sm" variant="outline" disabled={disabled || ids.length === 0}>
          Add to album
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogTitle>Add to album</DialogTitle>
        <DialogDescription>
          {ids.length} {ids.length === 1 ? 'photo' : 'photos'} from your library.
        </DialogDescription>
        <div className="mt-4 flex flex-col gap-2">
          {albums.isPending ? (
            <p className="text-sm text-muted-foreground">Loading albums…</p>
          ) : null}
          {albums.isError ? (
            <p className="text-sm text-destructive">{errorMessage(albums.error)}</p>
          ) : null}
          {albums.data && choices.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              You do not have an album you can add to yet.{' '}
              <Link
                to="/albums"
                className="text-primary underline-offset-4 hover:underline"
                onClick={() => setOpen(false)}
              >
                Create one
              </Link>
              .
            </p>
          ) : null}
          {choices.map((album) => (
            <Button
              key={album.id}
              type="button"
              variant="outline"
              className="justify-start"
              pending={add.isPending && add.variables === album.id}
              disabled={add.isPending}
              onClick={() => add.mutate(album.id)}
            >
              {album.title}
            </Button>
          ))}
          {add.isError ? (
            <p className="text-sm text-destructive">{errorMessage(add.error)}</p>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
