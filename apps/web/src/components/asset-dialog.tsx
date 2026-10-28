import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, ChevronLeft, ChevronRight, Heart, MoreVertical, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { thumbHashToDataURL } from 'thumbhash';
import { FaceAvatar } from '@/components/face-avatar';
import { useStatus } from '@/lib/status';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { useAssetBatch } from '@/lib/asset-batch';
import { api, errorMessage } from '@/lib/api';
import { assetUrl } from '@/lib/native';
import { formatBytes, formatWhen } from '@/lib/format';
import { cn } from '@/lib/utils';

interface ShownFace {
  id: string;
  box: { x: number; y: number; width: number; height: number };
  person: { id: string; name: string | null } | null;
}

function placeholder(thumbhash: string | null): string | undefined {
  if (!thumbhash) return undefined;
  try {
    const bytes = Uint8Array.from(atob(thumbhash), (char) => char.charCodeAt(0));
    return thumbHashToDataURL(bytes);
  } catch {
    return undefined;
  }
}

export function AssetDialog({
  assetId,
  ids,
  focusPersonId = null,
  onClose,
  onNeighbor,
}: {
  assetId: string | null;
  /** Photos in the current grid, newest first, so a swipe stays in that order. */
  ids: readonly string[];
  /** Face to select first, so a group photo opens on the person you came from. */
  focusPersonId?: string | null;
  onClose: () => void;
  onNeighbor: (id: string) => void;
}) {
  const [selection, setSelection] = useState<{ assetId: string; faceId: string } | null>(null);
  const [menuAssetId, setMenuAssetId] = useState<string | null>(null);
  const [menuFor, setMenuFor] = useState(assetId);
  if (menuFor !== assetId) {
    setMenuFor(assetId);
    setMenuAssetId(null);
  }
  const detail = useQuery({
    queryKey: ['asset', assetId],
    queryFn: () => api('assets.get', { params: { id: assetId! } }),
    enabled: assetId !== null,
  });
  const selectedId = selection?.assetId === assetId ? selection.faceId : null;
  const index = assetId ? ids.indexOf(assetId) : -1;
  const previousId = index > 0 ? (ids[index - 1] ?? null) : null;
  const nextId = index >= 0 && index < ids.length - 1 ? (ids[index + 1] ?? null) : null;
  const menuOpen = assetId !== null && menuAssetId === assetId;

  const update = useAssetBatch();
  const savingFavorite = update.isPending && update.variables?.isFavorite !== undefined;
  const savingArchive = update.isPending && update.variables?.isArchived !== undefined;
  const savingTrash = update.isPending && update.variables?.isTrashed !== undefined;

  function showNeighbor(id: string | null) {
    if (id) onNeighbor(id);
  }

  useEffect(() => {
    if (!assetId) return;
    const onKey = (event: KeyboardEvent) => {
      const target = event.target;
      if (target instanceof HTMLElement && target.closest('input, textarea, select')) return;
      const id =
        event.key === 'ArrowLeft' ? previousId : event.key === 'ArrowRight' ? nextId : null;
      if (!id) return;
      event.preventDefault();
      onNeighbor(id);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [assetId, nextId, onNeighbor, previousId]);

  const swipe = useHorizontalSwipe((direction) => {
    showNeighbor(direction < 0 ? previousId : nextId);
  });

  const asset = detail.data;
  const image =
    assetUrl(asset?.previewUrl ?? asset?.originalUrl) ?? placeholder(asset?.thumbhash ?? null);
  const faces = asset?.faces ?? [];
  const preferred = faces.find((face) => face.person?.id === focusPersonId) ?? faces[0] ?? null;
  const selected = faces.find((face) => face.id === selectedId) ?? preferred;
  const heading = asset ? viewerHeading(asset.capturedAt, asset.location?.city ?? null) : null;

  return (
    <Dialog open={assetId !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent fullscreen>
        <DialogTitle className="sr-only">{asset?.originalFilename ?? 'Photo'}</DialogTitle>
        <DialogDescription className="sr-only">
          {heading ? `${heading.date}${heading.sub ? `, ${heading.sub}` : ''}` : 'Photo details'}
        </DialogDescription>
        <div
          className="absolute inset-0 flex touch-pan-y items-center justify-center select-none"
          style={{ transform: swipe.dragX === 0 ? undefined : `translateX(${swipe.dragX}px)` }}
          {...swipe.handlers}
        >
          {detail.isPending ? <div className="h-full w-full animate-pulse bg-white/5" /> : null}
          {detail.isError ? (
            <p className="px-6 text-center text-sm text-white/80">
              This photo could not be opened.
            </p>
          ) : null}
          {asset?.type === 'video' ? (
            <video
              key={asset.id}
              src={assetUrl(asset.playbackUrl ?? asset.originalUrl)}
              poster={image}
              controls
              className="max-h-full max-w-full"
            />
          ) : null}
          {asset && asset.type !== 'video' ? (
            <FacePhoto
              image={image}
              faces={faces}
              framedId={menuOpen ? selectedId : null}
              onSelect={(faceId) => {
                if (!assetId) return;
                setSelection({ assetId, faceId });
                setMenuAssetId(assetId);
              }}
            />
          ) : null}
        </div>
        {previousId ? (
          <button
            type="button"
            aria-label="Previous"
            className="absolute top-1/2 left-2 z-20 grid size-11 -translate-y-1/2 place-items-center rounded-full bg-black/35 text-white"
            onClick={() => showNeighbor(previousId)}
          >
            <ChevronLeft />
          </button>
        ) : null}
        {nextId ? (
          <button
            type="button"
            aria-label="Next"
            className="absolute top-1/2 right-2 z-20 grid size-11 -translate-y-1/2 place-items-center rounded-full bg-black/35 text-white"
            onClick={() => showNeighbor(nextId)}
          >
            <ChevronRight />
          </button>
        ) : null}
        <header className="absolute inset-x-0 top-0 z-50 flex items-center gap-1 bg-gradient-to-b from-black/75 to-transparent px-1 pt-[max(0.25rem,env(safe-area-inset-top))] pb-10">
          <button
            type="button"
            aria-label="Back"
            className="grid size-11 shrink-0 place-items-center rounded-full text-white hover:bg-white/15"
            onClick={onClose}
          >
            <ArrowLeft />
          </button>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">{heading?.date ?? 'Photo'}</p>
            {heading?.sub ? <p className="truncate text-xs text-white/80">{heading.sub}</p> : null}
          </div>
          <button
            type="button"
            aria-label="Details"
            aria-expanded={menuOpen}
            className="grid size-11 shrink-0 place-items-center rounded-full text-white hover:bg-white/15"
            onClick={() => setMenuAssetId(menuOpen ? null : assetId)}
          >
            <MoreVertical />
          </button>
        </header>
        {menuOpen && asset ? (
          <>
            <button
              type="button"
              aria-label="Close details"
              className="absolute inset-0 z-30"
              onClick={() => setMenuAssetId(null)}
            />
            <div className="absolute top-[calc(3.25rem+env(safe-area-inset-top))] right-2 z-40 max-h-[min(32rem,calc(100dvh-5rem-env(safe-area-inset-top)))] w-[min(24rem,calc(100%-1rem))] overflow-y-auto rounded-xl bg-card p-4 text-card-foreground shadow-lg">
              <p className="font-medium break-words">{asset.originalFilename}</p>
              <p className="mt-1 text-sm text-muted-foreground">
                {formatWhen(asset.capturedAt)}
                {asset.location
                  ? ` · ${[asset.location.city, asset.location.country].filter(Boolean).join(', ')}`
                  : ''}
              </p>
              <p className="mt-1 text-sm text-muted-foreground">
                {formatBytes(asset.sizeBytes)}
                {asset.width && asset.height ? ` · ${asset.width} × ${asset.height}` : ''}
                {asset.camera?.model ? ` · ${asset.camera.model}` : ''}
                {asset.camera?.lens ? ` · ${asset.camera.lens}` : ''}
              </p>
              {selected ? (
                <div className="mt-4">
                  <FaceEditor
                    assetId={asset.id}
                    cropSrc={asset.previewUrl ?? asset.thumbnailUrl}
                    faces={faces}
                    selected={selected}
                    onSelect={(faceId) => {
                      if (assetId) setSelection({ assetId, faceId });
                    }}
                  />
                </div>
              ) : null}
              {asset.tags.length > 0 ? (
                <p className="mt-4 text-sm text-muted-foreground">
                  {asset.tags.map((tag, tagIndex) => (
                    <span key={tag.name}>
                      {tagIndex > 0 ? ', ' : ''}
                      <Link
                        to={`/search?q=${encodeURIComponent(tag.name)}`}
                        className="text-primary underline-offset-4 hover:underline"
                      >
                        {tag.name}
                      </Link>
                    </span>
                  ))}
                </p>
              ) : null}
              <div className="mt-4 flex flex-wrap gap-2">
                <Button
                  variant={asset.isFavorite ? 'default' : 'outline'}
                  size="sm"
                  pending={savingFavorite}
                  disabled={update.isPending}
                  onClick={() => update.mutate({ ids: [asset.id], isFavorite: !asset.isFavorite })}
                >
                  <Heart />
                  {savingFavorite ? 'Saving…' : asset.isFavorite ? 'Favorited' : 'Favorite'}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  pending={savingArchive}
                  disabled={update.isPending}
                  onClick={() => update.mutate({ ids: [asset.id], isArchived: !asset.isArchived })}
                >
                  {savingArchive ? 'Saving…' : asset.isArchived ? 'Unarchive' : 'Archive'}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  pending={savingTrash}
                  disabled={update.isPending}
                  onClick={() => {
                    const trashing = asset.trashedAt === null;
                    update.mutate(
                      { ids: [asset.id], isTrashed: trashing },
                      {
                        onSuccess: () => {
                          if (trashing) onClose();
                        },
                      },
                    );
                  }}
                >
                  <Trash2 />
                  {savingTrash ? 'Saving…' : asset.trashedAt ? 'Restore' : 'Trash'}
                </Button>
              </div>
              {update.isError ? (
                <p className="mt-2 text-sm text-destructive" role="alert">
                  {errorMessage(update.error)}
                </p>
              ) : null}
              {asset.originalUrl ? (
                <a
                  className="mt-3 inline-block text-sm text-primary underline-offset-4 hover:underline"
                  href={assetUrl(asset.originalUrl)}
                >
                  Download original
                </a>
              ) : null}
            </div>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function viewerHeading(
  capturedAt: string | null,
  city: string | null,
): { date: string; sub: string } {
  if (!capturedAt) return { date: 'Undated', sub: city ?? '' };
  const when = new Date(capturedAt);
  const date = new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    ...(when.getFullYear() === new Date().getFullYear() ? {} : { year: 'numeric' as const }),
  }).format(when);
  const time = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(
    when,
  );
  return { date, sub: [time, city].filter(Boolean).join(' · ') };
}

function useHorizontalSwipe(onSwipe: (direction: -1 | 1) => void) {
  const start = useRef<{ x: number; y: number } | null>(null);
  const swiped = useRef(false);
  const [dragX, setDragX] = useState(0);

  function onPointerDown(event: React.PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    const target = event.target;
    if (target instanceof HTMLVideoElement) {
      const rect = target.getBoundingClientRect();
      if (event.clientY > rect.bottom - 48) return;
    }
    start.current = { x: event.clientX, y: event.clientY };
    swiped.current = false;
  }

  function onPointerMove(event: React.PointerEvent<HTMLDivElement>) {
    if (!start.current) return;
    const dx = event.clientX - start.current.x;
    const dy = event.clientY - start.current.y;
    if (Math.abs(dx) <= Math.abs(dy)) return;
    setDragX(dx);
  }

  function finish(event: React.PointerEvent<HTMLDivElement>) {
    if (!start.current) return;
    const dx = event.clientX - start.current.x;
    const dy = event.clientY - start.current.y;
    start.current = null;
    setDragX(0);
    if (Math.abs(dx) < 56 || Math.abs(dx) < Math.abs(dy)) return;
    swiped.current = true;
    onSwipe(dx < 0 ? 1 : -1);
  }

  function onClickCapture(event: React.MouseEvent<HTMLDivElement>) {
    if (!swiped.current) return;
    event.preventDefault();
    event.stopPropagation();
    swiped.current = false;
  }

  return {
    dragX,
    handlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp: finish,
      onPointerCancel: () => {
        start.current = null;
        setDragX(0);
      },
      onClickCapture,
    },
  };
}

function FacePhoto({
  image,
  faces,
  framedId,
  onSelect,
}: {
  image: string | undefined;
  faces: readonly ShownFace[];
  /** Set only after a tap, while tagging is open. Viewing a photo draws no boxes. */
  framedId: string | null;
  onSelect: (faceId: string) => void;
}) {
  const framed = faces.find((face) => face.id === framedId) ?? null;
  return (
    <div className="relative w-fit max-w-full">
      <img src={image} alt="" draggable={false} className="block max-h-dvh max-w-full" />
      {faces.map((face) => (
        <button
          key={face.id}
          type="button"
          aria-label={faceLabel(face)}
          aria-pressed={face.id === framedId}
          className={cn(
            'absolute rounded-sm',
            face.id === framedId
              ? 'border-2 border-white bg-white/15 shadow-[0_0_0_1px_rgba(0,0,0,0.65)]'
              : 'border-0 bg-transparent',
          )}
          style={{
            left: `${face.box.x * 100}%`,
            top: `${face.box.y * 100}%`,
            width: `${face.box.width * 100}%`,
            height: `${face.box.height * 100}%`,
          }}
          onClick={() => onSelect(face.id)}
        />
      ))}
      {framed ? (
        <span
          className="pointer-events-none absolute rounded bg-[#1c1915]/80 px-1.5 py-0.5 text-xs text-white"
          style={{
            left: `${framed.box.x * 100}%`,
            top: `calc(${(framed.box.y + framed.box.height) * 100}% + 4px)`,
          }}
        >
          {framed.person?.name ?? 'Unnamed'}
        </span>
      ) : null}
    </div>
  );
}

function FaceEditor({
  assetId,
  cropSrc,
  faces,
  selected,
  onSelect,
}: {
  assetId: string;
  cropSrc: string | null;
  faces: readonly ShownFace[];
  selected: ShownFace;
  onSelect: (faceId: string) => void;
}) {
  const queryClient = useQueryClient();
  const announce = useStatus();
  const people = useQuery({
    queryKey: ['people'],
    queryFn: () => api('people.list'),
  });
  const [filter, setFilter] = useState('');
  const [moveTarget, setMoveTarget] = useState<{ faceId: string; personId: string } | null>(null);
  const [nameDraft, setNameDraft] = useState<{ personId: string; value: string } | null>(null);
  const moveId = moveTarget?.faceId === selected.id ? moveTarget.personId : '';
  const personId = selected.person?.id ?? null;
  const nameValue =
    personId && nameDraft?.personId === personId ? nameDraft.value : (selected.person?.name ?? '');

  async function refresh() {
    await queryClient.invalidateQueries({ queryKey: ['people'] });
    await queryClient.invalidateQueries({ queryKey: ['asset', assetId] });
    await queryClient.invalidateQueries({ queryKey: ['explore'] });
    await queryClient.invalidateQueries({ queryKey: ['search'] });
  }

  const rename = useMutation({
    mutationFn: () =>
      api('people.update', {
        params: { id: personId! },
        body: { name: nameValue.trim() ? nameValue.trim() : null },
      }),
    onSuccess: async () => {
      setNameDraft(null);
      announce('Saved');
      await refresh();
    },
  });
  const move = useMutation({
    mutationFn: (nextPersonId: string) =>
      api('faces.update', { params: { id: selected.id }, body: { personId: nextPersonId } }),
    onSuccess: async () => {
      setMoveTarget(null);
      announce('Moved this face');
      await refresh();
    },
  });
  const createPerson = useMutation({
    mutationFn: () =>
      api('faces.update', { params: { id: selected.id }, body: { createPerson: true } }),
    onSuccess: async () => {
      announce('New person');
      await refresh();
    },
  });
  const reject = useMutation({
    mutationFn: () =>
      api('faces.notThisPerson', { params: { id: selected.id }, body: { personId: personId! } }),
    onSuccess: async () => {
      announce('Removed from this person');
      await refresh();
    },
  });

  const group = people.data?.people.find((person) => person.id === personId);
  const needle = filter.trim().toLowerCase();
  const choices = (people.data?.people ?? []).filter((person) => {
    if (person.id === personId) return false;
    if (!needle) return true;
    return (person.name ?? 'unnamed').toLowerCase().includes(needle);
  });
  const busy = rename.isPending || move.isPending || createPerson.isPending || reject.isPending;
  const faceError = rename.error ?? move.error ?? createPerson.error ?? reject.error;

  return (
    <div className="flex flex-col gap-3">
      <div>
        <p className="text-sm font-medium">Faces in this photo</p>
        <p className="mt-1 text-sm text-muted-foreground">
          Click a face to choose who you are naming. Naming saves the whole group. Moving changes
          only this face.
        </p>
      </div>
      <div className="flex gap-2 overflow-x-auto" role="group" aria-label="Faces in this photo">
        {faces.map((face) => (
          <button
            key={face.id}
            type="button"
            aria-label={faceLabel(face)}
            aria-pressed={face.id === selected.id}
            className="flex w-16 shrink-0 flex-col items-center gap-1"
            onClick={() => onSelect(face.id)}
          >
            <span
              className={cn(
                'size-14 overflow-hidden rounded-full bg-secondary',
                face.id === selected.id ? 'ring-2 ring-primary' : 'ring-1 ring-border',
              )}
            >
              <FaceAvatar src={cropSrc} box={face.box} alt="" />
            </span>
            <span className="w-full truncate text-center text-xs">
              {face.person?.name ?? 'Unnamed'}
            </span>
          </button>
        ))}
      </div>
      <div className="flex items-center gap-3">
        <span className="size-16 shrink-0 overflow-hidden rounded-full bg-secondary">
          <FaceAvatar src={cropSrc} box={selected.box} alt="" />
        </span>
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{selected.person?.name ?? 'Unnamed'}</p>
          <p className="text-sm text-muted-foreground">
            {group
              ? `${group.faceCount} ${group.faceCount === 1 ? 'face' : 'faces'} in this group`
              : 'Not in a group yet'}
          </p>
        </div>
      </div>
      {personId ? (
        <form
          className="flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            rename.mutate();
          }}
        >
          <Input
            aria-label="Name"
            value={nameValue}
            placeholder="Name"
            onChange={(event) => setNameDraft({ personId, value: event.target.value })}
          />
          <Button type="submit" pending={rename.isPending} disabled={busy}>
            {rename.isPending ? 'Saving…' : 'Save name'}
          </Button>
        </form>
      ) : null}
      {personId ? (
        <Link
          to={`/people/${personId}`}
          className="text-sm text-primary underline-offset-4 hover:underline"
        >
          Open this person
        </Link>
      ) : null}
      <div className="flex flex-col gap-2">
        <p className="text-sm font-medium">Move only this face to</p>
        {(people.data?.people.length ?? 0) > 8 ? (
          <Input
            aria-label="Filter people"
            value={filter}
            placeholder="Filter by name"
            onChange={(event) => setFilter(event.target.value)}
          />
        ) : null}
        {choices.length === 0 ? (
          <p className="text-sm text-muted-foreground">No one else to move this face to.</p>
        ) : (
          <div
            className="grid max-h-40 grid-cols-4 gap-2 overflow-y-auto"
            role="group"
            aria-label="Move only this face to"
          >
            {choices.map((person) => (
              <button
                key={person.id}
                type="button"
                aria-pressed={moveId === person.id}
                title={`${person.name ?? 'Unnamed'}, ${person.faceCount} faces`}
                className="flex min-w-0 flex-col items-center gap-1 rounded-md p-1 hover:bg-accent"
                onClick={() => setMoveTarget({ faceId: selected.id, personId: person.id })}
              >
                <span
                  className={cn(
                    'aspect-square w-full overflow-hidden rounded-full bg-secondary',
                    moveId === person.id ? 'ring-2 ring-primary' : 'ring-1 ring-border',
                  )}
                >
                  <FaceAvatar src={person.coverUrl} box={person.coverBox} alt="" />
                </span>
                <span className="w-full truncate text-center text-xs">
                  {person.name ?? 'Unnamed'}
                </span>
              </button>
            ))}
          </div>
        )}
        <Button
          type="button"
          variant="outline"
          size="sm"
          pending={move.isPending}
          disabled={!moveId || busy}
          onClick={() => move.mutate(moveId)}
        >
          {move.isPending ? 'Moving…' : 'Move this face'}
        </Button>
      </div>
      <div className="flex flex-wrap gap-2">
        {personId ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            pending={reject.isPending}
            disabled={busy}
            onClick={() => reject.mutate()}
          >
            {reject.isPending ? 'Removing…' : 'Not this person'}
          </Button>
        ) : null}
        <Button
          type="button"
          variant="outline"
          size="sm"
          pending={createPerson.isPending}
          disabled={busy}
          onClick={() => createPerson.mutate()}
        >
          {createPerson.isPending ? 'Creating…' : 'New person'}
        </Button>
      </div>
      {faceError ? <p className="text-sm text-destructive">{errorMessage(faceError)}</p> : null}
    </div>
  );
}

function faceLabel(face: ShownFace): string {
  return face.person?.name ? `${face.person.name} face` : 'Unnamed face';
}
