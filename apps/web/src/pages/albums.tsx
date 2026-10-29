import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { AssetDialog } from '@/components/asset-dialog';
import { PhotoGrid } from '@/components/photo-grid';
import { SelectionBar } from '@/components/selection-bar';
import { EmptyState, ErrorState, Field, FormError, LoadingBlock, Page } from '@/components/states';
import { useStatus } from '@/lib/status';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { api } from '@/lib/api';
import { useAssetParam } from '@/lib/asset-route';
import { formText } from '@/lib/form';
import { assetUrl } from '@/lib/native';
import { useSession } from '@/session-context';

export function AlbumsPage() {
  const navigate = useNavigate();
  const announce = useStatus();
  const queryClient = useQueryClient();
  const albums = useQuery({ queryKey: ['albums'], queryFn: () => api('albums.list') });
  const create = useMutation({
    mutationFn: (body: { title: string; description?: string }) => api('albums.create', { body }),
    onSuccess: async (result) => {
      announce('Album created');
      await queryClient.invalidateQueries({ queryKey: ['albums'] });
      void navigate(`/albums/${result.album.id}`);
    },
  });

  function onCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const description = formText(data, 'description').trim();
    create.mutate(
      {
        title: formText(data, 'title').trim(),
        ...(description ? { description } : {}),
      },
      { onSuccess: () => form.reset() },
    );
  }

  return (
    <Page wide title="Albums">
      <Card>
        <CardHeader>
          <CardTitle>New album</CardTitle>
        </CardHeader>
        <CardContent>
          <form className="flex flex-col gap-4" onSubmit={onCreate}>
            <Field label="Title">
              <Input name="title" required maxLength={200} />
            </Field>
            <Field label="Description" hint="Optional.">
              <Input name="description" maxLength={2000} />
            </Field>
            <FormError error={create.error} />
            <Button type="submit" className="self-start" pending={create.isPending}>
              {create.isPending ? 'Creating…' : 'Create album'}
            </Button>
          </form>
        </CardContent>
      </Card>

      {albums.isPending ? <LoadingBlock label="Loading albums" /> : null}
      {albums.isError ? (
        <ErrorState
          title="Couldn't load albums"
          error={albums.error}
          onRetry={() => void albums.refetch()}
        />
      ) : null}
      {albums.data && albums.data.albums.length === 0 ? (
        <EmptyState
          title="No albums yet"
          body="Make one, then add photos from the library."
        />
      ) : null}
      {albums.data && albums.data.albums.length > 0 ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {albums.data.albums.map((album) => (
            <Link
              key={album.id}
              to={`/albums/${album.id}`}
              className="overflow-hidden rounded-xl border border-border bg-card active:brightness-90"
            >
              <span className="block aspect-[4/3] bg-secondary">
                {album.coverUrl ? (
                  <img
                    src={assetUrl(album.coverUrl)}
                    alt=""
                    className="h-full w-full object-cover"
                  />
                ) : null}
              </span>
              <span className="block px-3 py-3">
                <span className="flex items-center gap-2">
                  <span className="truncate font-medium">{album.title}</span>
                  {album.invited ? <Badge>Invited</Badge> : null}
                </span>
                <span className="mt-1 block text-sm text-muted-foreground">
                  {album.assetCount} {album.assetCount === 1 ? 'photo' : 'photos'}
                  {album.role === 'owner' ? '' : ` · ${album.owner.name}`}
                </span>
              </span>
            </Link>
          ))}
        </div>
      ) : null}
    </Page>
  );
}

export function AlbumPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const { me } = useSession();
  const selfId = me?.user.id;
  const queryClient = useQueryClient();
  const announce = useStatus();
  const viewer = useAssetParam();
  const [selected, setSelected] = useState<Set<string> | null>(null);
  const album = useQuery({
    queryKey: ['albums', id],
    queryFn: () => api('albums.get', { params: { id } }),
    enabled: id.length > 0,
  });
  const photos = useInfiniteQuery({
    queryKey: ['albums', id, 'assets'],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      api('albums.assets', {
        params: { id },
        query: pageParam ? { cursor: pageParam, limit: 100 } : { limit: 100 },
      }),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: id.length > 0 && album.data?.album.invited === false,
  });
  const directory = useQuery({
    queryKey: ['users', 'directory'],
    queryFn: () => api('users.directory'),
    enabled: album.data?.album.role === 'owner',
  });

  const invalidate = async () => {
    await queryClient.invalidateQueries({ queryKey: ['albums'] });
    await queryClient.invalidateQueries({ queryKey: ['timeline'] });
  };

  const save = useMutation({
    mutationFn: (body: { title?: string; description?: string | null }) =>
      api('albums.update', { params: { id }, body }),
    onSuccess: async () => {
      announce('Saved');
      await invalidate();
    },
  });
  const removeAlbum = useMutation({
    mutationFn: () => api('albums.delete', { params: { id } }),
    onSuccess: async () => {
      announce('Album deleted');
      await invalidate();
      void navigate('/albums');
    },
  });
  const join = useMutation({
    mutationFn: () => api('albums.join', { params: { id } }),
    onSuccess: async () => {
      announce('Joined');
      await invalidate();
    },
  });
  const invite = useMutation({
    mutationFn: (body: { userId: string; role: 'viewer' | 'contributor' }) =>
      api('albums.members.add', { params: { id }, body }),
    onSuccess: async () => {
      announce('Invited');
      await invalidate();
    },
  });
  const memberUpdate = useMutation({
    mutationFn: (input: {
      userId: string;
      role?: 'viewer' | 'contributor';
      showInTimeline?: boolean;
    }) =>
      api('albums.members.update', {
        params: { id, userId: input.userId },
        body: {
          ...(input.role ? { role: input.role } : {}),
          ...(input.showInTimeline === undefined ? {} : { showInTimeline: input.showInTimeline }),
        },
      }),
    onSuccess: async () => {
      announce('Saved');
      await invalidate();
    },
  });
  const memberRemove = useMutation({
    mutationFn: (userId: string) => api('albums.members.remove', { params: { id, userId } }),
    onSuccess: async (_result, userId) => {
      announce(userId === selfId ? 'Left the album' : 'Removed');
      await invalidate();
      if (userId === selfId && album.data?.album.role !== 'owner') void navigate('/albums');
    },
  });
  const removePhotos = useMutation({
    mutationFn: (assetIds: string[]) =>
      api('albums.removeAssets', { params: { id }, body: { assetIds } }),
    onSuccess: async (result) => {
      announce(result.removed === 0 ? 'Nothing removed' : `Removed ${result.removed}`);
      setSelected(null);
      await invalidate();
    },
  });

  useEffect(() => {
    if (!selected) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setSelected(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selected]);

  const detail = album.data?.album;
  const assets = photos.data?.pages.flatMap((page) => page.items) ?? [];
  const ids = assets.map((asset) => asset.id);
  const canEditPhotos = detail?.role === 'owner' || detail?.role === 'contributor';
  const invitedIds = new Set(detail?.members.map((member) => member.user.id) ?? []);
  const inviteChoices = (directory.data?.users ?? []).filter((user) => !invitedIds.has(user.id));

  function toggle(assetId: string) {
    setSelected((current) => {
      const next = new Set(current ?? []);
      if (next.has(assetId)) next.delete(assetId);
      else next.add(assetId);
      return next;
    });
  }

  return (
    <Page wide title={detail?.title ?? 'Album'} lede={detail?.description ?? undefined}>
      <p>
        <Link to="/albums" className="text-sm text-primary underline-offset-4 hover:underline">
          All albums
        </Link>
      </p>
      {album.isPending ? <LoadingBlock label="Loading album" /> : null}
      {album.isError ? (
        <ErrorState
          title="Couldn't load this album"
          error={album.error}
          onRetry={() => void album.refetch()}
        />
      ) : null}
      {detail?.invited ? (
        <div className="flex flex-wrap gap-2">
          <Button pending={join.isPending} onClick={() => join.mutate()}>
            {join.isPending ? 'Joining…' : 'Accept invitation'}
          </Button>
          <Button
            variant="outline"
            pending={memberRemove.isPending}
            onClick={() => {
              if (selfId) memberRemove.mutate(selfId);
            }}
          >
            Decline
          </Button>
          <FormError error={join.error ?? memberRemove.error} />
        </div>
      ) : null}
      {detail && !detail.invited ? (
        <>
          {detail.role === 'owner' ? (
            <form
              className="flex flex-col gap-3"
              onSubmit={(event) => {
                event.preventDefault();
                const data = new FormData(event.currentTarget);
                const description = formText(data, 'description').trim();
                save.mutate({
                  title: formText(data, 'title').trim(),
                  description: description ? description : null,
                });
              }}
            >
              <Field label="Title">
                <Input name="title" defaultValue={detail.title} required maxLength={200} />
              </Field>
              <Field label="Description">
                <Input
                  name="description"
                  defaultValue={detail.description ?? ''}
                  maxLength={2000}
                />
              </Field>
              <FormError error={save.error} />
              <div className="flex flex-wrap gap-2">
                <Button type="submit" pending={save.isPending}>
                  {save.isPending ? 'Saving…' : 'Save album'}
                </Button>
                <Dialog>
                  <DialogTrigger asChild>
                    <Button type="button" variant="destructive">
                      Delete album
                    </Button>
                  </DialogTrigger>
                  <DialogContent>
                    <DialogTitle>Delete this album?</DialogTitle>
                    <DialogDescription>
                      The photos stay in the library. Only the album goes away.
                    </DialogDescription>
                    <div className="mt-6 flex justify-end gap-2">
                      <DialogClose asChild>
                        <Button type="button" variant="outline">
                          Keep it
                        </Button>
                      </DialogClose>
                      <Button
                        type="button"
                        variant="destructive"
                        pending={removeAlbum.isPending}
                        onClick={() => removeAlbum.mutate()}
                      >
                        {removeAlbum.isPending ? 'Deleting…' : 'Delete album'}
                      </Button>
                    </div>
                    <FormError error={removeAlbum.error} />
                  </DialogContent>
                </Dialog>
              </div>
            </form>
          ) : (
            <div className="flex flex-wrap items-center gap-3">
              <p className="text-sm text-muted-foreground">Shared by {detail.owner.name}</p>
              <Button
                variant="outline"
                pending={memberRemove.isPending}
                onClick={() => {
                  if (selfId) memberRemove.mutate(selfId);
                }}
              >
                {memberRemove.isPending ? 'Leaving…' : 'Leave album'}
              </Button>
            </div>
          )}

          {detail.role !== 'owner' ? (
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="size-4 accent-primary"
                checked={detail.showInTimeline}
                disabled={memberUpdate.isPending}
                onChange={(event) => {
                  if (selfId) {
                    memberUpdate.mutate({ userId: selfId, showInTimeline: event.target.checked });
                  }
                }}
              />
              Show in my timeline
            </label>
          ) : null}

          <section className="flex flex-col gap-3">
            <h2 className="font-serif text-2xl">People</h2>
            {detail.members.length === 0 ? (
              <p className="text-sm text-muted-foreground">Only you, so far.</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {detail.members.map((member) => (
                  <li
                    key={member.user.id}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border px-3 py-2"
                  >
                    <div>
                      <p className="text-sm">
                        {member.user.name}{' '}
                        <Badge variant="outline">
                          {member.status === 'invited' ? 'invited' : member.role}
                        </Badge>
                      </p>
                    </div>
                    {detail.role === 'owner' ? (
                      <div className="flex flex-wrap gap-2">
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          pending={
                            memberUpdate.isPending &&
                            memberUpdate.variables?.userId === member.user.id &&
                            memberUpdate.variables.role !== undefined
                          }
                          disabled={memberUpdate.isPending}
                          onClick={() =>
                            memberUpdate.mutate({
                              userId: member.user.id,
                              role: member.role === 'contributor' ? 'viewer' : 'contributor',
                            })
                          }
                        >
                          Make {member.role === 'contributor' ? 'viewer' : 'contributor'}
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          pending={
                            memberRemove.isPending && memberRemove.variables === member.user.id
                          }
                          disabled={memberRemove.isPending}
                          onClick={() => memberRemove.mutate(member.user.id)}
                        >
                          Remove
                        </Button>
                      </div>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
            <FormError error={memberUpdate.error ?? memberRemove.error} />
            {detail.role === 'owner' ? (
              <form
                className="flex flex-col gap-3 sm:flex-row sm:items-end"
                onSubmit={(event) => {
                  event.preventDefault();
                  const form = event.currentTarget;
                  const data = new FormData(form);
                  const userId = formText(data, 'userId');
                  if (!userId) return;
                  invite.mutate(
                    {
                      userId,
                      role: formText(data, 'role') === 'contributor' ? 'contributor' : 'viewer',
                    },
                    { onSuccess: () => form.reset() },
                  );
                }}
              >
                <Field label="Invite someone">
                  <select
                    name="userId"
                    className="h-10 rounded-md border border-input bg-card px-3 text-sm"
                    defaultValue=""
                  >
                    <option value="" disabled>
                      {inviteChoices.length === 0 ? 'No one else to invite' : 'Choose a person'}
                    </option>
                    {inviteChoices.map((user) => (
                      <option key={user.id} value={user.id}>
                        {user.name}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Role">
                  <select
                    name="role"
                    defaultValue="viewer"
                    className="h-10 rounded-md border border-input bg-card px-3 text-sm"
                  >
                    <option value="viewer">Viewer</option>
                    <option value="contributor">Contributor</option>
                  </select>
                </Field>
                <Button
                  type="submit"
                  pending={invite.isPending}
                  disabled={inviteChoices.length === 0}
                >
                  {invite.isPending ? 'Inviting…' : 'Invite'}
                </Button>
                <FormError error={invite.error} />
              </form>
            ) : null}
          </section>

          {photos.isPending ? <LoadingBlock label="Loading photos" /> : null}
          {photos.isError ? (
            <ErrorState
              title="Couldn't load photos"
              error={photos.error}
              onRetry={() => void photos.refetch()}
            />
          ) : null}
          {photos.data && assets.length === 0 ? (
            <EmptyState
              title="No photos in this album"
              body="Add some from the library."
              action={
                <Button asChild variant="outline">
                  <Link to="/">Go to the library</Link>
                </Button>
              }
            />
          ) : null}
          {assets.length > 0 ? (
            <>
              <div className="flex justify-end">
                <Button
                  type="button"
                  size="sm"
                  variant={selected ? 'default' : 'outline'}
                  onClick={() => setSelected(selected ? null : new Set())}
                >
                  {selected ? 'Done' : 'Select'}
                </Button>
              </div>
              <PhotoGrid
                assets={assets}
                selecting={selected !== null}
                selectedIds={selected ?? undefined}
                onOpen={viewer.open}
                onToggle={toggle}
                onHold={(assetId) =>
                  setSelected((current) => {
                    const next = new Set(current ?? []);
                    next.add(assetId);
                    return next;
                  })
                }
              />
            </>
          ) : null}
          {photos.hasNextPage ? (
            <Button
              type="button"
              variant="outline"
              className="self-start"
              pending={photos.isFetchingNextPage}
              onClick={() => void photos.fetchNextPage()}
            >
              {photos.isFetchingNextPage ? 'Loading…' : 'More'}
            </Button>
          ) : null}
          <AssetDialog
            assetId={viewer.assetId}
            ids={ids}
            onClose={viewer.close}
            onNeighbor={viewer.select}
          />
          {selected ? (
            <SelectionBar count={selected.size} onClear={() => setSelected(null)}>
              {canEditPhotos ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  pending={removePhotos.isPending}
                  disabled={selected.size === 0}
                  onClick={() => removePhotos.mutate([...selected])}
                >
                  {removePhotos.isPending ? 'Removing…' : 'Remove'}
                </Button>
              ) : null}
            </SelectionBar>
          ) : null}
          <FormError error={removePhotos.error} />
        </>
      ) : null}
    </Page>
  );
}
