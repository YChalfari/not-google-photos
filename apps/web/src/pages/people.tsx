import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { AssetDialog } from '@/components/asset-dialog';
import { FaceAvatar } from '@/components/face-avatar';
import { PhotoGrid } from '@/components/photo-grid';
import { EmptyState, ErrorState, LoadingBlock, Page } from '@/components/states';
import { useStatus } from '@/lib/status';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { api } from '@/lib/api';
import { useAssetParam } from '@/lib/asset-route';
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
        <ErrorState
          title="Couldn't load people"
          error={people.error}
          onRetry={() => void people.refetch()}
        />
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
            <Link
              key={person.id}
              to={`/people/${person.id}`}
              className="flex flex-col items-center gap-2"
            >
              <span className="aspect-square w-full overflow-hidden rounded-full bg-secondary">
                {person.coverUrl ? (
                  <FaceAvatar src={person.coverUrl} box={person.coverBox} alt="" />
                ) : (
                  <span className="flex h-full items-center justify-center text-lg text-muted-foreground">
                    {(person.name ?? '?').slice(0, 1)}
                  </span>
                )}
              </span>
              <span className="w-full truncate text-center text-sm">
                {person.name ?? 'Unnamed'}
              </span>
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
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const announce = useStatus();
  const viewer = useAssetParam();
  const [photoChoice, setPhotoChoice] = useState<{ personId: string; choosing: boolean }>({
    personId: id,
    choosing: false,
  });
  const photosRef = useRef<HTMLDivElement>(null);
  const choosingPhoto = photoChoice.personId === id && photoChoice.choosing;
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
  const [mergeSelection, setMergeSelection] = useState<{ personId: string; ids: string[] }>({
    personId: id,
    ids: [],
  });
  const draft = name ?? person.data?.person.name ?? '';
  const mergeIds = mergeSelection.personId === id ? mergeSelection.ids : [];

  const save = useMutation({
    mutationFn: () =>
      api('people.update', {
        params: { id },
        body: { name: draft.trim() ? draft.trim() : null },
      }),
    onSuccess: async () => {
      setName(null);
      announce('Saved');
      await queryClient.invalidateQueries({ queryKey: ['people'] });
    },
  });
  const hide = useMutation({
    mutationFn: (isHidden: boolean) => api('people.update', { params: { id }, body: { isHidden } }),
    onSuccess: async (_result, isHidden) => {
      announce(isHidden ? 'Hidden from People' : 'Shown in People');
      await queryClient.invalidateQueries({ queryKey: ['people'] });
    },
  });
  const merge = useMutation({
    mutationFn: (plan: { targetId: string; sourceIds: string[] }) =>
      api('people.merge', {
        params: { id: plan.targetId },
        body: { sourcePersonIds: plan.sourceIds },
      }),
    onSuccess: async (_person, plan) => {
      setMergeSelection({ personId: id, ids: [] });
      announce('Merged');
      await queryClient.invalidateQueries({ queryKey: ['people'] });
      if (plan.targetId !== id) void navigate(`/people/${plan.targetId}`);
    },
  });
  const chooseMain = useMutation({
    mutationFn: (assetId: string) =>
      api('people.update', { params: { id }, body: { coverAssetId: assetId } }),
    onSuccess: async () => {
      setPhotoChoice({ personId: id, choosing: false });
      announce('Photo updated');
      await queryClient.invalidateQueries({ queryKey: ['people'] });
    },
  });

  const mergeChoices = (others.data?.people ?? []).filter((item) => item.id !== id);
  const selectedPeople = mergeChoices.filter((item) => mergeIds.includes(item.id));
  const mergePlan = person.data ? mergeDestination(person.data.person, selectedPeople) : null;

  function toggleMerge(personId: string) {
    setMergeSelection((current) => {
      const ids = current.personId === id ? current.ids : [];
      const next = ids.includes(personId)
        ? ids.filter((item) => item !== personId)
        : ids.length >= 49
          ? ids
          : [...ids, personId];
      return { personId: id, ids: next };
    });
  }

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
        <ErrorState
          title="Couldn't load this person"
          error={person.error}
          onRetry={() => void person.refetch()}
        />
      ) : null}
      {person.data ? (
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
          <div className="flex shrink-0 flex-col items-center gap-2">
            <span className="size-24 overflow-hidden rounded-full bg-secondary">
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
            {photos.data && photos.data.items.length > 0 ? (
              <button
                type="button"
                className="text-sm text-primary underline-offset-4 hover:underline"
                onClick={() => {
                  const choosing = !choosingPhoto;
                  setPhotoChoice({ personId: id, choosing });
                  if (choosing)
                    photosRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                }}
              >
                {choosingPhoto ? 'Cancel' : 'Change photo'}
              </button>
            ) : null}
          </div>
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
            <Button type="submit" pending={save.isPending}>
              {save.isPending ? 'Saving…' : 'Save name'}
            </Button>
            <Button
              type="button"
              variant="outline"
              pending={hide.isPending}
              onClick={() => hide.mutate(!person.data.person.isHidden)}
            >
              {hide.isPending
                ? 'Saving…'
                : person.data.person.isHidden
                  ? 'Show in People'
                  : 'Hide from People'}
            </Button>
          </form>
        </div>
      ) : null}
      {mergeChoices.length > 0 ? (
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (mergePlan && mergePlan.sourceIds.length > 0) {
              merge.mutate({ targetId: mergePlan.target.id, sourceIds: mergePlan.sourceIds });
            }
          }}
        >
          <div>
            <p className="text-sm font-medium">Merge with someone</p>
            <p className="mt-1 text-sm text-muted-foreground">
              Select every matching face, including several at once. They join this person. If one
              of them already has a name, everyone joins that person, and that person's photo stays.
            </p>
          </div>
          <div
            className="grid max-h-64 grid-cols-4 gap-2 overflow-y-auto sm:grid-cols-6 md:grid-cols-8"
            role="group"
            aria-label="Merge with someone"
          >
            {mergeChoices.map((item) => {
              const picked = mergeIds.includes(item.id);
              return (
                <button
                  key={item.id}
                  type="button"
                  aria-pressed={picked}
                  title={`${item.name ?? 'Unnamed'}, ${item.faceCount} faces`}
                  className="flex min-w-0 flex-col items-center gap-1 rounded-md p-1 hover:bg-accent"
                  onClick={() => toggleMerge(item.id)}
                >
                  <span
                    className={cn(
                      'aspect-square w-full overflow-hidden rounded-full bg-secondary',
                      picked ? 'ring-2 ring-primary' : 'ring-1 ring-border',
                    )}
                  >
                    <FaceAvatar src={item.coverUrl} box={item.coverBox} alt="" />
                  </span>
                  <span className="w-full truncate text-center text-xs">
                    {item.name ?? 'Unnamed'}
                  </span>
                  <span className="text-xs text-muted-foreground">{item.faceCount}</span>
                </button>
              );
            })}
          </div>
          <div>
            <Button
              type="submit"
              variant="outline"
              pending={merge.isPending}
              disabled={!mergePlan || mergePlan.sourceIds.length === 0}
            >
              {merge.isPending
                ? 'Merging…'
                : mergePlan && mergePlan.sourceIds.length > 0
                  ? mergePlan.target.id === id
                    ? `Merge ${mergePlan.sourceIds.length} here`
                    : `Merge into ${mergePlan.target.name}`
                  : 'Merge'}
            </Button>
          </div>
        </form>
      ) : null}
      {save.isError ? <ErrorState title="Couldn't save that name" error={save.error} /> : null}
      {hide.isError ? <ErrorState title="Couldn't update People" error={hide.error} /> : null}
      {merge.isError ? (
        <ErrorState title="Couldn't merge those people" error={merge.error} />
      ) : null}
      {photos.isPending ? <LoadingBlock label="Loading photos" /> : null}
      {photos.isError ? (
        <ErrorState
          title="Couldn't load photos"
          error={photos.error}
          onRetry={() => void photos.refetch()}
        />
      ) : null}
      {photos.data && photos.data.items.length === 0 ? (
        <EmptyState title="No photos" body="Faces grouped with this person will show up here." />
      ) : null}
      {photos.data && photos.data.items.length > 0 ? (
        <div ref={photosRef} className="flex flex-col gap-3">
          {choosingPhoto ? (
            <p className="text-sm text-muted-foreground">
              {chooseMain.isPending ? 'Updating photo…' : 'Choose a photo for this person.'}
            </p>
          ) : null}
          {chooseMain.isError ? (
            <ErrorState title="Couldn't change the photo" error={chooseMain.error} />
          ) : null}
          <PhotoGrid
            assets={photos.data.items}
            onOpen={(assetId) => {
              if (choosingPhoto) chooseMain.mutate(assetId);
              else viewer.open(assetId);
            }}
          />
        </div>
      ) : null}
      <AssetDialog
        assetId={viewer.assetId}
        ids={photos.data?.items.map((item) => item.id) ?? []}
        focusPersonId={id}
        onClose={viewer.close}
        onNeighbor={viewer.select}
      />
    </Page>
  );
}

function mergeDestination(
  current: { id: string; name: string | null; faceCount: number },
  selected: readonly { id: string; name: string | null; faceCount: number }[],
): { target: { id: string; name: string | null }; sourceIds: string[] } {
  const named = selected.filter((person) => person.name);
  const target =
    current.name || named.length === 0
      ? current
      : [...named].sort(
          (left, right) => right.faceCount - left.faceCount || left.id.localeCompare(right.id),
        )[0]!;
  const sourceIds = [current.id, ...selected.map((person) => person.id)].filter(
    (personId) => personId !== target.id,
  );
  return { target, sourceIds };
}
