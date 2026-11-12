import { lazy, Suspense } from 'react';
import { Route, Routes } from 'react-router-dom';
import { PlaceholderPage, Shell } from '@/components/shell';
import { LoadingBlock } from '@/components/states';
import { AdminPage } from '@/pages/admin';
import { BackupPage } from '@/pages/backup';
import { ConnectPage } from '@/pages/connect';
import { InvitePage } from '@/pages/invite';
import { LibraryPage } from '@/pages/library';
import { ReviewPage } from '@/pages/review';
import { LoginPage } from '@/pages/login';
import { MemoryPage } from '@/pages/memory';
import { PeoplePage, PersonPage } from '@/pages/people';
import { SearchPage } from '@/pages/search';
import { SettingsPage } from '@/pages/settings';
import { SetupPage } from '@/pages/setup';
import { AlbumPage, AlbumsPage } from '@/pages/albums';
import { GuestOnly, RequireAdmin, RequireAuth } from '@/session';

const MapPage = lazy(() => import('@/pages/map').then((mod) => ({ default: mod.MapPage })));

export function App() {
  return (
    <Routes>
      <Route path="/setup" element={<SetupPage />} />
      <Route path="/connect" element={<ConnectPage />} />
      <Route path="/invite/:token" element={<InvitePage />} />
      <Route element={<GuestOnly />}>
        <Route path="/login" element={<LoginPage />} />
      </Route>
      <Route element={<RequireAuth />}>
        <Route element={<Shell />}>
          <Route path="/" element={<LibraryPage />} />
          <Route path="/people" element={<PeoplePage />} />
          <Route path="/people/:id" element={<PersonPage />} />
          <Route path="/albums" element={<AlbumsPage />} />
          <Route path="/albums/:id" element={<AlbumPage />} />
          <Route
            path="/map"
            element={
              <Suspense fallback={<LoadingBlock label="Loading the map" />}>
                <MapPage />
              </Suspense>
            }
          />
          <Route path="/search" element={<SearchPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/backup" element={<BackupPage />} />
          <Route path="/review" element={<ReviewPage />} />
          <Route path="/memories/:id" element={<MemoryPage />} />
          <Route element={<RequireAdmin />}>
            <Route path="/admin" element={<AdminPage />} />
          </Route>
          <Route
            path="*"
            element={
              <PlaceholderPage title="That page isn't here" body="Head back to the library." />
            }
          />
        </Route>
      </Route>
    </Routes>
  );
}
