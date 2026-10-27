import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { AssetDialog } from '@/components/asset-dialog';
import { PhotoGrid } from '@/components/photo-grid';
import { EmptyState, ErrorState, LoadingBlock, Page } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { api } from '@/lib/api';

export function PeoplePage() {
  const people = useQuery({
    queryKey: ['people'],
    queryFn: () => api('people.list'),
  });

  return (
    <Page
      title="People"
      wide
      lede="Faces are grouped on this computer as photos arrive. Name someone once, and later photos of them join the same person."
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
                  <img src={person.coverUrl} alt="" className="h-full w-full object-cover" />
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
    <Page title={person.data?.person.name ?? 'Unnamed'} wide lede="Photos of this person, newest first.">
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
        <form
          className="flex flex-col gap-3 sm:flex-row sm:items-center"
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
      ) : null}
      {mergeChoices.length > 0 ? (
        <form
          className="flex flex-col gap-3 sm:flex-row sm:items-center"
          onSubmit={(event) => {
            event.preventDefault();
            if (mergeId) merge.mutate();
          }}
        >
          <label className="flex flex-1 flex-col gap-1 text-sm">
            Same person as
            <select
              className="h-10 rounded-md border border-input bg-card px-3"
              value={mergeId}
              onChange={(event) => setMergeId(event.target.value)}
            >
              <option value="">Choose someone to merge in</option>
              {mergeChoices.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name ?? 'Unnamed'} ({item.faceCount})
                </option>
              ))}
            </select>
          </label>
          <Button type="submit" variant="outline" disabled={!mergeId || merge.isPending}>
            Merge
          </Button>
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
      <AssetDialog assetId={openId} onClose={() => setOpenId(null)} />
    </Page>
  );
}
