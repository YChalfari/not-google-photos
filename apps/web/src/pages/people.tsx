import type { PersonSummary } from '@ngp/shared';
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
  const [naming, setNaming] = useState(false);
  const people = useQuery({
    queryKey: ['people'],
    queryFn: () => api('people.list'),
  });
  const unnamed = people.data?.people.filter((person) => !person.name && !person.nameSkipped) ?? [];

  return (
    <Page title="People" wide>
      {people.isPending ? <LoadingBlock label="Loading people" /> : null}
      {people.isError ? (
        <ErrorState
          title="Couldn't load people"
          error={people.error}
          onRetry={() => void people.refetch()}
        />
      ) : null}
      {people.data && people.data.people.length === 0 ? (
        <EmptyState title="No people yet" body="They'll show up here." />
      ) : null}
      {naming && people.data ? (
        <NamingPass people={people.data.people} onExit={() => setNaming(false)} />
      ) : null}
      {!naming && unnamed.length > 0 ? (
        <div className="flex items-center justify-between gap-3">
          <p className="text-sm text-muted-foreground">
            {unnamed.length} {unnamed.length === 1 ? 'person has' : 'people have'} no name.
          </p>
          <Button type="button" onClick={() => setNaming(true)}>
            Name them
          </Button>
        </div>
      ) : null}
      {!naming && people.data && people.data.people.length > 0 ? (
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
                {person.important ? ' · Important' : ''}
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
  const [mergeQuery, setMergeQuery] = useState('');
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
  const markImportant = useMutation({
    mutationFn: (important: boolean) =>
      api('people.update', { params: { id }, body: { important } }),
    onSuccess: async (_result, important) => {
      announce(important ? 'Marked important' : 'No longer important');
      await queryClient.invalidateQueries({ queryKey: ['people'] });
      if (important) {
        await queryClient.invalidateQueries({ queryKey: ['assets'] });
        await queryClient.invalidateQueries({ queryKey: ['timeline'] });
      }
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
  const mergeFilter = mergeQuery.trim().toLowerCase();
  const visibleChoices = mergeChoices.filter((item) => {
    if (!mergeFilter) return true;
    return (item.name ?? 'unnamed').toLowerCase().includes(mergeFilter);
  });
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
    <Page title={person.data?.person.name ?? 'Unnamed'} wide>
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
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
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
          <div className="flex min-w-0 flex-1 flex-col gap-4">
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
            <label className="flex items-start gap-3 text-sm">
              <input
                type="checkbox"
                className="mt-0.5 size-4 accent-primary"
                checked={person.data.person.important}
                disabled={markImportant.isPending}
                onChange={(event) => markImportant.mutate(event.target.checked)}
              />
              <span>
                Important
                <span className="mt-1 block text-muted-foreground">
                  Photos of them from Downloads, WhatsApp, and other folders go into your library. A
                  photo still comes in when anyone in it is important.
                </span>
              </span>
            </label>
          </div>
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
            <p className="text-sm font-medium">Same person twice?</p>
          </div>
          <Input
            aria-label="Find someone to merge"
            placeholder="Find someone"
            value={mergeQuery}
            autoComplete="off"
            onChange={(event) => setMergeQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') event.preventDefault();
            }}
          />
          {visibleChoices.length === 0 ? (
            <p className="text-sm text-muted-foreground">No one matches that.</p>
          ) : (
            <div
              className="grid max-h-64 grid-cols-4 gap-2 overflow-y-auto sm:grid-cols-6 md:grid-cols-8"
              role="group"
              aria-label="Merge with someone"
            >
              {visibleChoices.map((item) => {
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
          )}
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
      {markImportant.isError ? (
        <ErrorState title="Couldn't update Important" error={markImportant.error} />
      ) : null}
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
        <EmptyState title="No photos" body="Nothing here yet." />
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

function NamingPass({ people, onExit }: { people: readonly PersonSummary[]; onExit: () => void }) {
  const queryClient = useQueryClient();
  const announce = useStatus();
  const queue = people.filter((person) => !person.name && !person.nameSkipped);
  const current = queue[0];
  const [draft, setDraft] = useState<{ id: string; name: string; important: boolean } | null>(null);
  const active = draft !== null && current && draft.id === current.id ? draft : null;
  const name = active?.name ?? '';
  const important = active?.important ?? false;

  const save = useMutation({
    mutationFn: (person: PersonSummary) =>
      api('people.update', {
        params: { id: person.id },
        body: { name: name.trim(), important },
      }),
    onSuccess: async () => {
      announce(`Named ${name.trim()}`);
      setDraft(null);
      await queryClient.invalidateQueries({ queryKey: ['people'] });
      if (important) {
        await queryClient.invalidateQueries({ queryKey: ['assets'] });
        await queryClient.invalidateQueries({ queryKey: ['timeline'] });
      }
    },
  });
  const skip = useMutation({
    mutationFn: (person: PersonSummary) =>
      api('people.update', { params: { id: person.id }, body: { nameSkipped: true } }),
    onSuccess: async () => {
      announce('Skipped');
      setDraft(null);
      await queryClient.invalidateQueries({ queryKey: ['people'] });
    },
  });

  if (!current) {
    return (
      <div className="flex flex-col items-start gap-3">
        <p className="text-sm text-muted-foreground">Everyone left is named or skipped.</p>
        <Button type="button" variant="outline" onClick={onExit}>
          Back to people
        </Button>
      </div>
    );
  }

  return (
    <form
      className="flex max-w-md flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (name.trim()) save.mutate(current);
      }}
    >
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          {queue.length} {queue.length === 1 ? 'person' : 'people'} left to name
        </p>
        <Button type="button" variant="ghost" onClick={onExit}>
          Back
        </Button>
      </div>
      <span className="size-40 overflow-hidden rounded-full bg-secondary">
        {current.coverUrl ? (
          <FaceAvatar src={current.coverUrl} box={current.coverBox} alt="" />
        ) : (
          <span className="flex h-full items-center justify-center text-3xl text-muted-foreground">
            ?
          </span>
        )}
      </span>
      <p className="text-sm text-muted-foreground">
        {current.faceCount} {current.faceCount === 1 ? 'face' : 'faces'}
      </p>
      <Input
        aria-label="Name"
        placeholder="Name"
        value={name}
        autoFocus
        onChange={(event) => setDraft({ id: current.id, name: event.target.value, important })}
      />
      <label className="flex items-start gap-3 text-sm">
        <input
          type="checkbox"
          className="mt-0.5 size-4 accent-primary"
          checked={important}
          onChange={(event) => setDraft({ id: current.id, name, important: event.target.checked })}
        />
        <span>
          Important
          <span className="mt-1 block text-muted-foreground">
            Photos of them from other folders go into your library.
          </span>
        </span>
      </label>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" pending={save.isPending} disabled={name.trim().length === 0}>
          {save.isPending ? 'Saving…' : 'Save'}
        </Button>
        <Button
          type="button"
          variant="outline"
          pending={skip.isPending}
          onClick={() => skip.mutate(current)}
        >
          {skip.isPending ? 'Skipping…' : 'Skip'}
        </Button>
      </div>
      {save.isError ? <ErrorState title="Couldn't save that name" error={save.error} /> : null}
      {skip.isError ? <ErrorState title="Couldn't skip this person" error={skip.error} /> : null}
    </form>
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
