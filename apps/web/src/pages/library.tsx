import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { EmptyState, ErrorState, LoadingBlock, Page } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { api } from '@/lib/api';
import { formatBytes } from '@/lib/format';
import { useSession } from '@/session-context';

export function LibraryPage() {
  const { me } = useSession();
  const storage = useQuery({
    queryKey: ['me', 'storage'],
    queryFn: () => api('me.storage'),
  });

  return (
    <Page
      title={me ? `${me.user.name}'s library` : 'Library'}
      lede="Photos land here from the phones you pair. The day-by-day timeline is the next piece; accounts, invites, and pairing are ready."
    >
      {storage.isPending ? <LoadingBlock label="Counting photos" /> : null}
      {storage.isError ? (
        <ErrorState
          title="Couldn't load your library"
          error={storage.error}
          onRetry={() => void storage.refetch()}
        />
      ) : null}
      {storage.data && storage.data.assetCount === 0 ? (
        <EmptyState
          title="No photos yet"
          body="Pair a phone from Settings. Photos you add stay on this machine. The timeline for browsing them is the next piece."
          action={
            <Button asChild>
              <Link to="/settings">Pair a phone</Link>
            </Button>
          }
        />
      ) : null}
      {storage.data && storage.data.assetCount > 0 ? (
        <div className="grid gap-3 sm:grid-cols-3">
          <Stat label="Photos" value={String(storage.data.byType.image.count)} />
          <Stat label="Videos" value={String(storage.data.byType.video.count)} />
          <Stat
            label="Stored"
            value={formatBytes(storage.data.usedBytes)}
            hint={
              storage.data.quotaBytes === null
                ? 'No quota'
                : `of ${formatBytes(storage.data.quotaBytes)}`
            }
          />
        </div>
      ) : null}
      {storage.data && storage.data.assetCount > 0 ? (
        <Card>
          <CardContent>
            <p className="text-sm text-muted-foreground">
              {storage.data.assetCount} {storage.data.assetCount === 1 ? 'item is' : 'items are'}{' '}
              stored in your account. Photos in a shared album stay with whoever uploaded them, so
              they are not added to this count. Browsing them in a grid comes next. Pair a phone
              from Settings.
            </p>
          </CardContent>
        </Card>
      ) : null}
    </Page>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <Card>
      <CardContent>
        <p className="text-xs tracking-wide text-muted-foreground uppercase">{label}</p>
        <p className="mt-1 font-serif text-3xl">{value}</p>
        {hint ? <p className="mt-1 text-xs text-muted-foreground">{hint}</p> : null}
      </CardContent>
    </Card>
  );
}
