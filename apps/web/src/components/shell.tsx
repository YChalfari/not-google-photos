import { useQueryClient } from '@tanstack/react-query';
import { CloudUpload, FolderHeart, Images, Search, Settings, Shield, Users } from 'lucide-react';
import type { ReactNode } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';
import { unpairThisPhone } from '@/lib/device';
import { isNativeApp, usesDeviceAuth } from '@/lib/native';
import { cn } from '@/lib/utils';
import { useSession } from '@/session-context';

const NAV = [
  { to: '/', label: 'Library', icon: Images, end: true },
  { to: '/people', label: 'People', icon: Users, end: false },
  { to: '/albums', label: 'Albums', icon: FolderHeart, end: false },
  { to: '/search', label: 'Search', icon: Search, end: false },
] as const;

export function Shell() {
  const { info, me, refresh } = useSession();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const admin = me?.user.role === 'admin';
  const onPhone = isNativeApp();
  const deviceAuth = usesDeviceAuth();

  async function logout() {
    if (deviceAuth) {
      await unpairThisPhone();
      queryClient.setQueryData(['device', 'connection'], false);
      await refresh();
      void navigate('/connect');
      return;
    }
    await api('auth.logout');
    await refresh();
    void navigate('/login');
  }

  return (
    <div className="min-h-screen md:grid md:grid-cols-[240px_1fr]">
      <aside className="hidden border-r border-border/80 bg-card/70 md:flex md:flex-col md:px-4 md:py-6">
        <Brand name={info?.name} />
        <nav className="mt-8 flex flex-1 flex-col gap-1">
          {NAV.map((item) => (
            <SideLink key={item.to} {...item} />
          ))}
        </nav>
        <div className="flex flex-col gap-1 border-t border-border pt-4">
          {onPhone ? <SideLink to="/backup" label="Backup" icon={CloudUpload} end={false} /> : null}
          <SideLink to="/settings" label="Settings" icon={Settings} end={false} />
          {admin ? <SideLink to="/admin" label="Admin" icon={Shield} end={false} /> : null}
          <button
            type="button"
            className="mt-2 rounded-md px-3 py-2 text-left text-sm text-muted-foreground hover:bg-accent"
            onClick={() => void logout()}
          >
            {deviceAuth ? 'Unpair this phone' : 'Sign out'}
          </button>
        </div>
      </aside>

      <div className="flex min-h-screen flex-col">
        <header className="flex items-center justify-between gap-3 px-4 pt-[max(1rem,env(safe-area-inset-top))] pb-4 md:hidden">
          <Brand name={info?.name} />
          <div className="flex items-center gap-1">
            {onPhone ? (
              <Button variant="ghost" size="icon" asChild>
                <NavLink to="/backup" aria-label="Backup">
                  <CloudUpload />
                </NavLink>
              </Button>
            ) : null}
            {admin ? (
              <Button variant="ghost" size="icon" asChild>
                <NavLink to="/admin" aria-label="Admin">
                  <Shield />
                </NavLink>
              </Button>
            ) : null}
            <Button variant="ghost" size="icon" asChild>
              <NavLink to="/settings" aria-label="Settings">
                <Settings />
              </NavLink>
            </Button>
          </div>
        </header>
        <main className="flex-1 px-4 pt-2 pb-24 md:px-8 md:py-8">
          <Outlet />
        </main>
        <nav className="fixed inset-x-0 bottom-0 z-20 grid grid-cols-4 border-t border-border bg-card/95 px-2 pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] backdrop-blur md:hidden">
          {NAV.map((item) => (
            <BottomLink key={item.to} {...item} />
          ))}
        </nav>
      </div>
    </div>
  );
}

function Brand({ name }: { name: string | undefined }) {
  return (
    <div className="flex items-center gap-3 px-1">
      <span className="grid size-9 place-items-center rounded-lg bg-primary font-serif text-sm text-primary-foreground">
        ng
      </span>
      <div className="min-w-0">
        <p className="truncate font-serif text-lg leading-none">{name ?? 'Not Google Photos'}</p>
        <p className="mt-1 text-xs text-muted-foreground">Your library, at home</p>
      </div>
    </div>
  );
}

function SideLink({
  to,
  label,
  icon: Icon,
  end,
}: {
  to: string;
  label: string;
  icon: typeof Images;
  end: boolean;
}) {
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) =>
        cn(
          'flex items-center gap-2 rounded-md px-3 py-2 text-sm',
          isActive ? 'bg-primary text-primary-foreground' : 'hover:bg-accent',
        )
      }
    >
      <Icon className="size-4" />
      {label}
    </NavLink>
  );
}

function BottomLink({
  to,
  label,
  icon: Icon,
  end,
}: {
  to: string;
  label: string;
  icon: typeof Images;
  end: boolean;
}) {
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) =>
        cn(
          'flex flex-col items-center gap-1 rounded-md py-1 text-[11px]',
          isActive ? 'text-primary' : 'text-muted-foreground',
        )
      }
    >
      <Icon className="size-5" />
      {label}
    </NavLink>
  );
}

export function PlaceholderPage({ title, body }: { title: string; body: string }) {
  return (
    <section className="mx-auto flex w-full max-w-3xl flex-col gap-6">
      <h1 className="font-serif text-3xl font-medium tracking-tight">{title}</h1>
      <div className="rounded-xl border border-dashed border-border bg-card px-6 py-12 text-center">
        <h2 className="font-serif text-2xl">Coming with the next piece</h2>
        <p className="mx-auto mt-2 max-w-md text-muted-foreground">{body}</p>
      </div>
    </section>
  );
}

export function GuestFrame({ children }: { children: ReactNode }) {
  return (
    <div className="mx-auto flex min-h-screen w-full max-w-md flex-col justify-center px-4 py-10">
      <div className="mb-8 flex items-center gap-3">
        <span className="grid size-10 place-items-center rounded-lg bg-primary font-serif text-primary-foreground">
          ng
        </span>
        <p className="font-serif text-2xl">Not Google Photos</p>
      </div>
      {children}
    </div>
  );
}
