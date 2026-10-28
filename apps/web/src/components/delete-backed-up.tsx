import { PhotoSync, type FreeUpResult, type FreeableSummary } from '@ngp/photo-sync';
import { useState } from 'react';
import { FormError } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';

const DELETE_ALL_BACKED_UP = { olderThanDays: 0, keepFavorites: false, mediaType: 'all' } as const;
const CONFIRM_WORD = 'DELETE';

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = value >= 10 || Number.isInteger(value) ? 0 : 1;
  return `${value.toFixed(digits)} ${units[unit]}`;
}

function countPhrase(count: number, singular: string, plural: string): string | null {
  if (count === 0) return null;
  return count === 1 ? `1 ${singular}` : `${count} ${plural}`;
}

function describeSummary(summary: FreeableSummary): string {
  if (summary.count === 0) return 'Nothing on this phone is confirmed in your library.';
  const parts = [
    countPhrase(summary.photos, 'photo', 'photos'),
    countPhrase(summary.videos, 'video', 'videos'),
  ].filter((part) => part !== null);
  return `This will delete ${parts.join(' and ')} from this phone, about ${formatBytes(summary.bytes)}.`;
}

function describeOutcome(result: FreeUpResult): string {
  const left =
    result.skippedUnverified === 0
      ? ''
      : result.skippedUnverified === 1
        ? ' 1 item stayed on the phone because the server could not confirm it.'
        : ` ${result.skippedUnverified} items stayed on the phone because the server could not confirm them.`;
  if (result.deleted === 0) return `Nothing was deleted.${left}`;
  const removed = result.deleted === 1 ? '1 item' : `${result.deleted} items`;
  const lead = result.cancelled
    ? `Deleted ${removed} (about ${formatBytes(result.bytesFreed)}) before the rest was cancelled.`
    : `Deleted ${removed} from this phone (about ${formatBytes(result.bytesFreed)}).`;
  return `${lead}${left}`;
}

export function DeleteBackedUpCard({
  backedUp,
  pending,
  disabled,
  onFinished,
}: {
  backedUp: number;
  pending: number;
  disabled: boolean;
  onFinished: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [summary, setSummary] = useState<FreeableSummary | null>(null);
  const [typed, setTyped] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [outcome, setOutcome] = useState<FreeUpResult | null>(null);
  const [busy, setBusy] = useState(false);
  const confirmed = typed === CONFIRM_WORD;
  const canDelete = confirmed && (summary?.count ?? 0) > 0 && !busy && outcome === null;

  function close() {
    if (busy) return;
    setOpen(false);
    setTyped('');
    setOutcome(null);
    setSummary(null);
  }

  async function openDialog() {
    setBusy(true);
    setError(null);
    setOutcome(null);
    setTyped('');
    try {
      const next = await PhotoSync.getFreeableSummary(DELETE_ALL_BACKED_UP);
      setSummary(next);
      setOpen(true);
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  }

  async function deleteFromPhone() {
    if (!canDelete) return;
    setBusy(true);
    setError(null);
    try {
      const result = await PhotoSync.freeUpSpace(DELETE_ALL_BACKED_UP);
      setOutcome(result);
      onFinished();
    } catch (caught) {
      setError(caught);
      onFinished();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Free space on this phone</CardTitle>
        <CardDescription>
          Delete photos and videos from this phone once they are stored in your library.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col items-start gap-3">
        <Button
          type="button"
          variant="destructive"
          disabled={disabled || busy || backedUp === 0}
          onClick={() => void openDialog()}
        >
          {busy && !open ? 'Checking the library…' : 'Delete backed-up photos from this phone'}
        </Button>
        {backedUp === 0 ? (
          <p className="text-sm text-muted-foreground">
            {pending > 0
              ? 'These photos have not been confirmed with the server yet. Back up now checks them immediately. Refresh only reloads these numbers.'
              : 'Nothing backed up is still on this phone.'}
          </p>
        ) : null}
        {!open ? <FormError error={error} /> : null}
      </CardContent>
      <Dialog open={open} onOpenChange={(next) => (next ? setOpen(true) : close())}>
        <DialogContent
          onEscapeKeyDown={(event) => {
            if (busy) event.preventDefault();
          }}
          onPointerDownOutside={(event) => {
            if (busy) event.preventDefault();
          }}
        >
          <DialogTitle>Delete backed-up photos from this phone?</DialogTitle>
          <DialogDescription>
            {summary && summary.count > 0
              ? 'This permanently deletes every photo and video on this phone that is already in your library, including favorites and photos from today. Your library keeps its copies. Photos and videos that are still waiting to upload remain on the phone. Android then asks you to allow the deletion.'
              : 'Checked your library before deleting anything from this phone.'}
          </DialogDescription>
          {summary ? <p className="mt-4 text-sm">{describeSummary(summary)}</p> : null}
          {outcome ? <p className="mt-4 text-sm">{describeOutcome(outcome)}</p> : null}
          {outcome === null && (summary?.count ?? 0) > 0 ? (
            <form
              className="mt-4 flex flex-col gap-3"
              onSubmit={(event) => {
                event.preventDefault();
                void deleteFromPhone();
              }}
            >
              <label className="flex flex-col gap-1.5 text-sm font-medium">
                Type {CONFIRM_WORD} to confirm
                <Input
                  value={typed}
                  onChange={(event) => setTyped(event.target.value)}
                  autoComplete="off"
                  autoCapitalize="characters"
                  spellCheck={false}
                  disabled={busy}
                />
              </label>
              <FormError error={error} />
              <div className="flex justify-end gap-2">
                <Button type="button" variant="outline" disabled={busy} onClick={close}>
                  Cancel
                </Button>
                <Button type="submit" variant="destructive" disabled={!canDelete}>
                  {busy ? 'Deleting…' : 'Delete from this phone'}
                </Button>
              </div>
            </form>
          ) : (
            <div className="mt-6 flex flex-col gap-3">
              <FormError error={error} />
              <div className="flex justify-end">
                <DialogClose asChild>
                  <Button type="button" variant="outline" disabled={busy} onClick={close}>
                    Close
                  </Button>
                </DialogClose>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </Card>
  );
}
