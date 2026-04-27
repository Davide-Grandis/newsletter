import { Navigate, NavLink, Route, Routes } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { AuthProvider, useAuth } from './auth';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import Subscribers from './pages/Subscribers';
import Campaigns from './pages/Campaigns';
import CampaignDetail from './pages/CampaignDetail';
import Bounces from './pages/Bounces';

export default function App() {
  return (
    <AuthProvider>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route element={<RequireAuth />}>
          <Route element={<Layout />}>
            <Route index element={<Dashboard />} />
            <Route path="subscribers" element={<Subscribers />} />
            <Route path="campaigns" element={<Campaigns />} />
            <Route path="campaigns/:id" element={<CampaignDetail />} />
            <Route path="bounces" element={<Bounces />} />
          </Route>
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AuthProvider>
  );
}

function RequireAuth() {
  const { token } = useAuth();
  if (!token) return <Navigate to="/login" replace />;
  return <Outlet />;
}

import { Outlet, useNavigate } from 'react-router-dom';

interface Me {
  email: string | null;
  name: string | null;
  protected_by_access: boolean;
}

function Layout() {
  const { logout } = useAuth();
  const nav = useNavigate();
  // /api/me is unauthenticated and reads the Cloudflare Access identity
  // headers the edge injects when the app is behind an Access application.
  const me = useQuery({
    queryKey: ['me'],
    queryFn: () => fetch('/api/me').then((r) => r.json() as Promise<Me>),
    staleTime: 5 * 60_000,
  });

  function onLogout() {
    logout();
    if (me.data?.protected_by_access) {
      // Ends the Cloudflare Access session as well; redirects back to the app.
      window.location.href = '/cdn-cgi/access/logout';
    } else {
      nav('/login');
    }
  }

  const display = me.data?.name?.trim() || me.data?.email || null;

  return (
    <div className="min-h-full flex flex-col">
      <header className="border-b bg-white">
        <div className="max-w-6xl mx-auto px-4 h-14 flex items-center gap-6">
          <span className="font-semibold text-slate-900">Newsletter Admin</span>
          <nav className="flex gap-4 text-sm">
            <NavLink to="/" end className={navCls}>Dashboard</NavLink>
            <NavLink to="/subscribers" className={navCls}>Subscribers</NavLink>
            <NavLink to="/campaigns" className={navCls}>Campaigns</NavLink>
            <NavLink to="/bounces" className={navCls}>Bounces</NavLink>
          </nav>
          <div className="ml-auto flex items-center gap-3 text-sm">
            {display && (
              <span
                className="flex items-center gap-2 text-slate-600"
                title={me.data?.email ?? ''}
              >
                <span
                  aria-hidden
                  className="w-6 h-6 rounded-full bg-slate-900 text-white text-xs flex items-center justify-center font-medium"
                >
                  {display.slice(0, 1).toUpperCase()}
                </span>
                <span className="hidden sm:inline">{display}</span>
              </span>
            )}
            <button
              onClick={onLogout}
              className="text-slate-500 hover:text-slate-900 border rounded px-2 py-1"
            >
              Logout
            </button>
          </div>
        </div>
      </header>
      <main className="flex-1 max-w-6xl w-full mx-auto px-4 py-6">
        <Outlet />
      </main>
    </div>
  );
}

function navCls({ isActive }: { isActive: boolean }) {
  return isActive
    ? 'text-slate-900 font-medium border-b-2 border-slate-900 pb-3.5 -mb-px'
    : 'text-slate-500 hover:text-slate-900';
}
