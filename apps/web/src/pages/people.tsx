import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { AssetDialog } from '@/components/asset-dialog';
import { FaceAvatar } from '@/components/face-avatar';
import { PhotoGrid } from '@/components/photo-grid';
import { EmptyState, ErrorState, LoadingBlock, Page } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';

export function PeoplePage() {
  const people = useQuery({
    queryKey: ['people'],
    queryFn: () => api('people.list'),
  });

  return (
    <Page
      title="People"
      wide
      lede="Each circle is one person's face, even in a group photo. Name someone once, and later photos of them join the same person."
    >
      {people.isPending ? <LoadingBlock label="Loading people" /> : null}
      {people.isError ? (
        <ErrorState title="Couldn't load people" error={people.error} onRetry={() => void people.refetch()} />
      ) : null}
      {people.data && people.data.people.length === 0 ? (
        <EmptyState
          title="No people yet"
          body="Photos already in the library are scanned in the background. New uploads are scanned as they arrive. Birthday, party, cake, cat, and dog tags show up in Search."
        />
      ) : null}
      {people.data && people.data.people.length > 0 ? (
        <div className="grid grid-cols-3 gap-4 sm:grid-cols-4 md:grid-cols-6">
          {people.data.people.map((person) => (
            <Link key={person.id} to={`/people/${person.id}`} className="flex flex-col items-center gap-2">
              <span className="aspect-square w-full overflow-hidden rounded-full bg-secondary">
                {person.coverUrl ? (
                  <FaceAvatar src={person.coverUrl} box={person.coverBox} alt="" />
                ) : (
                  <span className="flex h-full items-center justify-center text-lg text-muted-foreground">
                    {(person.name ?? '?').slice(0, 1)}
                  </span>
                )}
              </span>
              <span className="w-full truncate text-center text-sm">{person.name ?? 'Unnamed'}</span>
              <span className="text-xs text-muted-foreground">
                {person.faceCount} {person.faceCount === 1 ? 'face' : 'faces'}
              </span>
            </Link>
          ))}
        </div>
      ) : null}
    </Page>
  );
}

export function PersonPage() {
  const { id = '' } = useParams();
  const queryClient = useQueryClient();
  const [openId, setOpenId] = useState<string | null>(null);
  const person = useQuery({
    queryKey: ['people', id],
    queryFn: () => api('people.get', { params: { id } }),
    enabled: id.length > 0,
  });
  const photos = useQuery({
    queryKey: ['people', id, 'assets'],
    queryFn: () => api('people.assets', { params: { id } }),
    enabled: id.length > 0,
  });
  const others = useQuery({
    queryKey: ['people'],
    queryFn: () => api('people.list'),
  });
  const [name, setName] = useState<string | null>(null);
  const [mergeId, setMergeId] = useState('');
  const draft = name ?? person.data?.person.name ?? '';

  const save = useMutation({
    mutationFn: () =>
      api('people.update', {
        params: { id },
        body: { name: draft.trim() ? draft.trim() : null },
      }),
    onSuccess: async () => {
      setName(null);
      await queryClient.invalidateQueries({ queryKey: ['people'] });
    },
  });
  const hide = useMutation({
    mutationFn: (isHidden: boolean) => api('people.update', { params: { id }, body: { isHidden } }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['people'] });
    },
  });
  const merge = useMutation({
    mutationFn: () => api('people.merge', { params: { id }, body: { sourcePersonIds: [mergeId] } }),
    onSuccess: async () => {
      setMergeId('');
      await queryClient.invalidateQueries({ queryKey: ['people'] });
    },
  });

  const mergeChoices = (others.data?.people ?? []).filter((item) => item.id !== id);

  return (
    <Page
      title={person.data?.person.name ?? 'Unnamed'}
      wide
      lede="The circle is the face you are naming. Open a group photo and click that face if the wrong person was grouped here."
    >
      <p>
        <Link to="/people" className="text-sm text-primary underline-offset-4 hover:underline">
          All people
        </Link>
      </p>
      {person.isPending ? <LoadingBlock label="Loading person" /> : null}
      {person.isError ? (
        <ErrorState title="Couldn't load this person" error={person.error} onRetry={() => void person.refetch()} />
      ) : null}
      {person.data ? (
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
          <span className="size-24 shrink-0 overflow-hidden rounded-full bg-secondary">
            {person.data.person.coverUrl ? (
              <FaceAvatar
                src={person.data.person.coverUrl}
                box={person.data.person.coverBox}
                alt={person.data.person.name ?? 'Unnamed'}
              />
            ) : (
              <span className="flex h-full items-center justify-center text-2xl text-muted-foreground">
                {(person.data.person.name ?? '?').slice(0, 1)}
              </span>
            )}
          </span>
          <form
            className="flex flex-1 flex-col gap-3 sm:flex-row sm:items-center"
            onSubmit={(event) => {
              event.preventDefault();
              save.mutate();
            }}
          >
            <Input
              aria-label="Name"
              value={draft}
              placeholder="Name"
              onChange={(event) => setName(event.target.value)}
            />
            <Button type="submit" disabled={save.isPending}>
              Save name
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={hide.isPending}
              onClick={() => hide.mutate(!person.data.person.isHidden)}
            >
              {person.data.person.isHidden ? 'Show in People' : 'Hide from People'}
            </Button>
          </form>
        </div>
      ) : null}
      {mergeChoices.length > 0 ? (
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (mergeId) merge.mutate();
          }}
        >
          <div>
            <p className="text-sm font-medium">Merge with someone</p>
            <p className="mt-1 text-sm text-muted-foreground">
              Pick the face that is this same person. Every photo in that group moves here.
            </p>
          </div>
          <div
            className="grid max-h-64 grid-cols-4 gap-2 overflow-y-auto sm:grid-cols-6 md:grid-cols-8"
            role="group"
            aria-label="Merge with someone"
          >
            {mergeChoices.map((item) => (
              <button
                key={item.id}
                type="button"
                aria-pressed={mergeId === item.id}
                title={`${item.name ?? 'Unnamed'}, ${item.faceCount} faces`}
                className="flex min-w-0 flex-col items-center gap-1 rounded-md p-1 hover:bg-accent"
                onClick={() => setMergeId(item.id)}
              >
                <span
                  className={cn(
                    'aspect-square w-full overflow-hidden rounded-full bg-secondary',
                    mergeId === item.id ? 'ring-2 ring-primary' : 'ring-1 ring-border',
                  )}
                >
                  <FaceAvatar src={item.coverUrl} box={item.coverBox} alt="" />
                </span>
                <span className="w-full truncate text-center text-xs">{item.name ?? 'Unnamed'}</span>
                <span className="text-xs text-muted-foreground">{item.faceCount}</span>
              </button>
            ))}
          </div>
          <div>
            <Button type="submit" variant="outline" disabled={!mergeId || merge.isPending}>
              Merge
            </Button>
          </div>
        </form>
      ) : null}
      {save.isError ? <ErrorState title="Couldn't save that name" error={save.error} /> : null}
      {merge.isError ? <ErrorState title="Couldn't merge those people" error={merge.error} /> : null}
      {photos.isPending ? <LoadingBlock label="Loading photos" /> : null}
      {photos.isError ? (
        <ErrorState title="Couldn't load photos" error={photos.error} onRetry={() => void photos.refetch()} />
      ) : null}
      {photos.data && photos.data.items.length === 0 ? (
        <EmptyState title="No photos" body="Faces grouped with this person will show up here." />
      ) : null}
      {photos.data && photos.data.items.length > 0 ? (
        <PhotoGrid assets={photos.data.items} onOpen={setOpenId} />
      ) : null}
      <AssetDialog assetId={openId} focusPersonId={id} onClose={() => setOpenId(null)} />
    </Page>
  );
}
