import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { AssetDialog } from '@/components/asset-dialog';
import { FaceAvatar } from '@/components/face-avatar';
import { PhotoGrid } from '@/components/photo-grid';
import { EmptyState, ErrorState, LoadingBlock, Page } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { api } from '@/lib/api';
import { useAssetParam } from '@/lib/asset-route';

export function SearchPage() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? '';
  const tag = params.get('tag') ?? '';
  const city = params.get('city') ?? '';
  const type = params.get('type') ?? '';
  const cursor = params.get('cursor') ?? '';
  const [draft, setDraft] = useState(q);
  const viewer = useAssetParam();
  const searching = q.length > 0 || tag.length > 0 || city.length > 0 || type.length > 0;

  const suggestions = useQuery({
    queryKey: ['search-suggestions', draft],
    queryFn: () => api('search.suggestions', { query: { q: draft.trim() } }),
    enabled: draft.trim().length >= 2 && draft.trim() !== q,
  });
  const results = useQuery({
    queryKey: ['search', q, tag, city, type, cursor],
    queryFn: () =>
      api('search.query', {
        query: {
          ...(q ? { q } : {}),
          ...(tag ? { tag } : {}),
          ...(city ? { city } : {}),
          ...(type === 'image' || type === 'video' ? { type } : {}),
          ...(cursor ? { cursor } : {}),
        },
      }),
    enabled: searching,
  });
  const explore = useQuery({
    queryKey: ['explore'],
    queryFn: () => api('explore.get'),
    enabled: !searching,
  });

  function replace(next: Record<string, string | null>) {
    const paramsNext = new URLSearchParams(params);
    for (const [key, value] of Object.entries(next)) {
      if (value) paramsNext.set(key, value);
      else paramsNext.delete(key);
    }
    paramsNext.delete('cursor');
    setParams(paramsNext);
  }

  return (
    <Page
      title="Search"
      wide
      lede="Find a person, a birthday, a party, a cake, a cat, or a dog. Recognition stays on this computer."
    >
      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          const text = draft.trim();
          replace({ q: text || null, tag: null, city: null, type: null });
        }}
      >
        <div className="flex gap-2">
          <Input
            aria-label="Search"
            value={draft}
            placeholder="Maya, cake, cats, birthday…"
            onChange={(event) => setDraft(event.target.value)}
          />
          <Button type="submit">Search</Button>
        </div>
        {suggestions.data && suggestions.data.suggestions.length > 0 ? (
          <div className="flex flex-wrap gap-2">
            {suggestions.data.suggestions.map((item) => (
              <Button
                key={`${item.kind}:${item.value}`}
                type="button"
                size="sm"
                variant="outline"
                onClick={() => {
                  if (item.kind === 'person') {
                    void navigate(`/people/${item.value}`);
                    return;
                  }
                  if (item.kind === 'tag') {
                    setDraft('');
                    replace({ tag: item.value, q: null, city: null, type: null });
                    return;
                  }
                  if (item.kind === 'place') {
                    setDraft('');
                    replace({ city: item.value, q: null, tag: null, type: null });
                    return;
                  }
                  setDraft(item.value);
                  replace({ q: item.value, tag: null, city: null, type: null });
                }}
              >
                {item.label}
              </Button>
            ))}
          </div>
        ) : null}
      </form>

      {searching ? (
        <>
          <p className="text-sm text-muted-foreground">
            {q ? `“${q}”` : null}
            {tag ? ` tagged ${tag}` : null}
            {city ? ` in ${city}` : null}
            {type ? ` ${type}s` : null}
            {' · '}
            <button type="button" className="underline-offset-4 hover:underline" onClick={() => replace({ q: null, tag: null, city: null, type: null })}>
              Clear
            </button>
          </p>
          {results.isPending ? <LoadingBlock label="Searching" /> : null}
          {results.isError ? (
            <ErrorState title="Couldn't search" error={results.error} onRetry={() => void results.refetch()} />
          ) : null}
          {results.data && results.data.items.length === 0 ? (
            <EmptyState title="Nothing matched" body="Try a person, cake, cats, dogs, birthday, or party." />
          ) : null}
          {results.data && results.data.items.length > 0 ? (
            <PhotoGrid assets={results.data.items} onOpen={viewer.open} />
          ) : null}
          {results.data?.nextCursor ? (
            <Button variant="outline" onClick={() => setParams((current) => {
              const next = new URLSearchParams(current);
              next.set('cursor', results.data.nextCursor ?? '');
              return next;
            })}>
              More
            </Button>
          ) : null}
        </>
      ) : null}

      {!searching && explore.isPending ? <LoadingBlock label="Loading explore" /> : null}
      {!searching && explore.isError ? (
        <ErrorState title="Couldn't load explore" error={explore.error} onRetry={() => void explore.refetch()} />
      ) : null}
      {!searching && explore.data ? (
        <div className="flex flex-col gap-8">
          {explore.data.people.length > 0 ? (
            <section className="flex flex-col gap-3">
              <h2 className="font-serif text-2xl">People</h2>
              <div className="flex flex-wrap gap-3">
                {explore.data.people.map((person) => (
                  <Link key={person.id} to={`/people/${person.id}`} className="flex w-20 flex-col items-center gap-1">
                    <span className="size-16 overflow-hidden rounded-full bg-secondary">
                      <FaceAvatar src={person.coverUrl} box={person.coverBox} alt="" />
                    </span>
                    <span className="w-full truncate text-center text-xs">{person.name ?? 'Unnamed'}</span>
                  </Link>
                ))}
              </div>
            </section>
          ) : null}
          <section className="flex flex-col gap-3">
            <h2 className="font-serif text-2xl">Things</h2>
            {explore.data.things.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Cake, cats, dogs, birthdays, and parties show up here once scanning finishes.
              </p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {explore.data.things.map((thing) => (
                  <Button key={thing.value} type="button" variant="outline" onClick={() => replace({ tag: thing.value, q: null })}>
                    {thing.label}
                    <span className="text-muted-foreground">{thing.count}</span>
                  </Button>
                ))}
              </div>
            )}
          </section>
          {explore.data.places.length > 0 ? (
            <section className="flex flex-col gap-3">
              <h2 className="font-serif text-2xl">Places</h2>
              <div className="flex flex-wrap gap-2">
                {explore.data.places.map((place) => (
                  <Button key={place.value} type="button" variant="outline" onClick={() => replace({ city: place.value, q: null })}>
                    {place.label}
                  </Button>
                ))}
              </div>
            </section>
          ) : null}
          <section className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" onClick={() => replace({ type: 'video', q: null })}>
              Videos
              <span className="text-muted-foreground">{explore.data.videos.count}</span>
            </Button>
            <Button type="button" variant="outline" onClick={() => replace({ q: 'screenshot' })}>
              Screenshots
              <span className="text-muted-foreground">{explore.data.screenshots.count}</span>
            </Button>
          </section>
        </div>
      ) : null}
      <AssetDialog
        assetId={viewer.assetId}
        ids={results.data?.items.map((item) => item.id) ?? []}
        onClose={viewer.close}
        onNeighbor={viewer.select}
      />
    </Page>
  );
}
