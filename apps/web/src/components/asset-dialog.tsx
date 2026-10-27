import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Heart, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { thumbHashToDataURL } from 'thumbhash';
import { FaceAvatar } from '@/components/face-avatar';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
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
  focusPersonId = null,
  onClose,
}: {
  assetId: string | null;
  /** Face to select first, so a group photo opens on the person you came from. */
  focusPersonId?: string | null;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [selection, setSelection] = useState<{ assetId: string; faceId: string } | null>(null);
  const detail = useQuery({
    queryKey: ['asset', assetId],
    queryFn: () => api('assets.get', { params: { id: assetId! } }),
    enabled: assetId !== null,
  });
  const selectedId = selection?.assetId === assetId ? selection.faceId : null;

  const update = useMutation({
    mutationFn: (body: { isFavorite?: boolean; isArchived?: boolean; isTrashed?: boolean }) =>
      api('assets.update', { body: { ids: [assetId!], ...body } }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['asset', assetId] });
      await queryClient.invalidateQueries({ queryKey: ['timeline'] });
    },
  });

  const asset = detail.data;
  const image =
    assetUrl(asset?.previewUrl ?? asset?.originalUrl) ?? placeholder(asset?.thumbhash ?? null);
  const faces = asset?.faces ?? [];
  const preferred = faces.find((face) => face.person?.id === focusPersonId) ?? faces[0] ?? null;
  const selected = faces.find((face) => face.id === selectedId) ?? preferred;

  return (
    <Dialog open={assetId !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[min(100%-2rem,56rem)] w-[min(100%-2rem,76rem)] overflow-y-auto p-0">
        <DialogTitle className="sr-only">{asset?.originalFilename ?? 'Photo'}</DialogTitle>
        <DialogDescription className="sr-only">
          {asset?.localDate ?? 'Photo details'}
        </DialogDescription>
        {detail.isPending ? <div className="h-80 animate-pulse bg-secondary" /> : null}
        {detail.isError ? (
          <p className="p-6 text-sm text-muted-foreground">This photo could not be opened.</p>
        ) : null}
        {asset ? (
          <div className="flex flex-col md:flex-row">
            <div className="flex min-h-64 min-w-0 flex-1 items-center justify-center bg-[#1c1915]">
              {asset.type === 'video' ? (
                <video
                  src={assetUrl(asset.playbackUrl ?? asset.originalUrl)}
                  poster={image}
                  controls
                  className="max-h-[70vh] w-full"
                />
              ) : (
                <FacePhoto
                  image={image}
                  faces={faces}
                  selectedId={selected?.id ?? null}
                  onSelect={(faceId) => {
                    if (assetId) setSelection({ assetId, faceId });
                  }}
                />
              )}
            </div>
            <div className="flex w-full flex-col gap-4 p-5 md:max-h-[80vh] md:w-80 md:overflow-y-auto">
              <div>
                <p className="font-medium break-words">{asset.originalFilename}</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  {formatWhen(asset.capturedAt)}
                  {asset.location?.city ? ` · ${asset.location.city}` : ''}
                </p>
                <p className="mt-1 text-sm text-muted-foreground">
                  {formatBytes(asset.sizeBytes)}
                  {asset.camera?.model ? ` · ${asset.camera.model}` : ''}
                </p>
              </div>
              {selected ? (
                <FaceEditor
                  assetId={asset.id}
                  cropSrc={asset.previewUrl ?? asset.thumbnailUrl}
                  faces={faces}
                  selected={selected}
                  onSelect={(faceId) => {
                    if (assetId) setSelection({ assetId, faceId });
                  }}
                  onClose={onClose}
                />
              ) : null}
              {asset.tags.length > 0 ? (
                <p className="text-sm text-muted-foreground">
                  {asset.tags.map((tag, index) => (
                    <span key={tag.name}>
                      {index > 0 ? ', ' : ''}
                      <Link
                        to={`/search?q=${encodeURIComponent(tag.name)}`}
                        onClick={onClose}
                        className="text-primary underline-offset-4 hover:underline"
                      >
                        {tag.name}
                      </Link>
                    </span>
                  ))}
                </p>
              ) : null}
              <div className="flex flex-wrap gap-2">
                <Button
                  variant={asset.isFavorite ? 'default' : 'outline'}
                  size="sm"
                  disabled={update.isPending}
                  onClick={() => update.mutate({ isFavorite: !asset.isFavorite })}
                >
                  <Heart />
                  {asset.isFavorite ? 'Favorited' : 'Favorite'}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={update.isPending}
                  onClick={() => update.mutate({ isArchived: !asset.isArchived })}
                >
                  {asset.isArchived ? 'Unarchive' : 'Archive'}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={update.isPending}
                  onClick={() => {
                    update.mutate(
                      { isTrashed: asset.trashedAt === null },
                      { onSuccess: () => onClose() },
                    );
                  }}
                >
                  <Trash2 />
                  {asset.trashedAt ? 'Restore' : 'Trash'}
                </Button>
              </div>
              {asset.originalUrl ? (
                <a
                  className="text-sm text-primary underline-offset-4 hover:underline"
                  href={assetUrl(asset.originalUrl)}
                >
                  Download original
                </a>
              ) : null}
            </div>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function FacePhoto({
  image,
  faces,
  selectedId,
  onSelect,
}: {
  image: string | undefined;
  faces: readonly ShownFace[];
  selectedId: string | null;
  onSelect: (faceId: string) => void;
}) {
  const selected = faces.find((face) => face.id === selectedId) ?? null;
  return (
    <div className="relative w-fit max-w-full">
      <img src={image} alt="" className="block max-h-[70vh] max-w-full" />
      {faces.map((face) => (
        <button
          key={face.id}
          type="button"
          aria-label={faceLabel(face)}
          aria-pressed={face.id === selectedId}
          className={cn(
            'absolute rounded-sm border-2 shadow-[0_0_0_1px_rgba(0,0,0,0.65)]',
            face.id === selectedId
              ? 'border-white bg-white/15'
              : 'border-white/75 hover:bg-white/10',
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
      {selected ? (
        <span
          className="pointer-events-none absolute rounded bg-[#1c1915]/80 px-1.5 py-0.5 text-xs text-white"
          style={{
            left: `${selected.box.x * 100}%`,
            top: `calc(${(selected.box.y + selected.box.height) * 100}% + 4px)`,
          }}
        >
          {selected.person?.name ?? 'Unnamed'}
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
  onClose,
}: {
  assetId: string;
  cropSrc: string | null;
  faces: readonly ShownFace[];
  selected: ShownFace;
  onSelect: (faceId: string) => void;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
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
      await refresh();
    },
  });
  const move = useMutation({
    mutationFn: (nextPersonId: string) =>
      api('faces.update', { params: { id: selected.id }, body: { personId: nextPersonId } }),
    onSuccess: async () => {
      setMoveTarget(null);
      await refresh();
    },
  });
  const createPerson = useMutation({
    mutationFn: () =>
      api('faces.update', { params: { id: selected.id }, body: { createPerson: true } }),
    onSuccess: async () => {
      await refresh();
    },
  });
  const reject = useMutation({
    mutationFn: () =>
      api('faces.notThisPerson', { params: { id: selected.id }, body: { personId: personId! } }),
    onSuccess: async () => {
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
          <Button type="submit" disabled={busy}>
            Save name
          </Button>
        </form>
      ) : null}
      {personId ? (
        <Link
          to={`/people/${personId}`}
          onClick={onClose}
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
          disabled={!moveId || busy}
          onClick={() => move.mutate(moveId)}
        >
          Move this face
        </Button>
      </div>
      <div className="flex flex-wrap gap-2">
        {personId ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => reject.mutate()}
          >
            Not this person
          </Button>
        ) : null}
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() => createPerson.mutate()}
        >
          New person
        </Button>
      </div>
      {faceError ? <p className="text-sm text-destructive">{errorMessage(faceError)}</p> : null}
    </div>
  );
}

function faceLabel(face: ShownFace): string {
  return face.person?.name ? `${face.person.name} face` : 'Unnamed face';
}
