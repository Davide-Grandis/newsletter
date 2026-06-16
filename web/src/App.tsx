import { useEffect, useRef, useState } from 'react';
import { Navigate, NavLink, Outlet, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { logoutAccess, useIdentity } from './auth';
import { useTheme, type Theme } from './theme';
import { api } from './api';
import Dashboard from './pages/Dashboard';
import Newsletters from './pages/Newsletters';
import NewsletterDetail from './pages/NewsletterDetail';
import Campaigns from './pages/Campaigns';
import CampaignDetail from './pages/CampaignDetail';
import Bounces from './pages/Bounces';
import Logs from './pages/Logs';
import Settings from './pages/Settings';
import Help from './pages/Help';
import type { Identity } from './auth';

export default function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Dashboard />} />
        <Route path="newsletters" element={<Newsletters />} />
        <Route path="newsletters/:id" element={<NewsletterDetail />} />
        <Route path="campaigns" element={<Campaigns />} />
        <Route path="campaigns/:id" element={<CampaignDetail />} />
        <Route path="bounces" element={<Bounces />} />
        <Route path="logs" element={<Logs />} />
        <Route path="settings" element={<Settings />} />
        <Route path="help" element={<Help />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

// Sidebar links, filtered by the signed-in user's role. Settings is
// super_admin-only (it now also hosts the "Super admins" tab). Regular admins
// are managed within each newsletter, so there is no standalone Users page.
function navItems(me?: Identity) {
  const isSuper = me?.role === 'super_admin';
  return [
    { to: '/', label: 'Dashboard', end: true, show: true },
    { to: '/newsletters', label: 'Newsletters', end: false, show: true },
    { to: '/campaigns', label: 'Campaigns', end: false, show: true },
    { to: '/bounces', label: 'Bounces', end: false, show: true },
    { to: '/logs', label: 'Analytics', end: false, show: true },
    { to: '/settings', label: 'Settings', end: false, show: isSuper },
    { to: '/help', label: 'Help', end: false, show: true },
  ].filter((i) => i.show);
}

function saveTheme(theme: Theme) {
  // Fire-and-forget; a failed save just means the preference isn't synced yet.
  api('/api/preferences', { method: 'PUT', body: JSON.stringify({ theme }) }).catch(() => {});
}

function Layout() {
  const me = useIdentity();
  const navigate = useNavigate();
  const display = me.data?.name?.trim() || me.data?.email || null;
  const navLinks = navItems(me.data);
  const [open, setOpen] = useState(true);
  // One-time dismissal of the "finish login setup" prompt for this session.
  const [setupDismissed, setSetupDismissed] = useState(false);
  const { theme, setTheme } = useTheme();
  // Analytics shows a wide multi-column table, so it gets extra width; every
  // other page keeps the standard reading width.
  const { pathname } = useLocation();
  const contentWidth = pathname.startsWith('/logs') ? 'max-w-screen-2xl' : 'max-w-6xl';

  // Apply the user's stored preference once their identity loads. The server
  // is the source of truth (so the theme follows the user across devices). If
  // no preference exists yet, seed it with the current (OS-detected) theme.
  const synced = useRef(false);
  useEffect(() => {
    if (synced.current || !me.data?.email) return;
    synced.current = true;
    if (me.data.theme === 'light' || me.data.theme === 'dark') {
      setTheme(me.data.theme);
    } else {
      saveTheme(theme);
    }
  }, [me.data, theme, setTheme]);

  function toggleTheme() {
    const next: Theme = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    if (me.data?.email) saveTheme(next);
  }

  // Authenticated through Access but not provisioned as a console user: show a
  // dead-end screen rather than an empty app with failing API calls.
  if (me.data?.no_access) return <NoAccess email={me.data.email} />;

  // Mandatory deployment settings: the Cloudflare Access login IDs and the
  // sending domain. If a super_admin signs in before they are set, prompt them
  // to finish setup. Only super_admins can edit Settings, so the nudge targets
  // them.
  const isSuper = me.data?.role === 'super_admin';
  const missingAccess = me.data?.access_configured === false;
  const missingDomain = (me.data?.base_domain ?? '') === '';
  const needsSetup = isSuper && (missingAccess || missingDomain) && !setupDismissed;

  return (
    <div className="h-screen flex flex-col">
      {needsSetup && (
        <SetupRequiredModal
          missingAccess={missingAccess}
          missingDomain={missingDomain}
          onAddSettings={() => {
            setSetupDismissed(true);
            navigate('/settings');
          }}
          onLogout={logoutAccess}
        />
      )}
      <header className="shrink-0 border-b border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
        <div className="px-4 h-14 flex items-center gap-3">
          <button
            onClick={() => setOpen((v) => !v)}
            aria-label={open ? 'Collapse sidebar' : 'Expand sidebar'}
            aria-expanded={open}
            className="p-2 -ml-2 rounded text-slate-500 hover:text-slate-900 hover:bg-slate-100 dark:hover:text-slate-100 dark:hover:bg-slate-800"
          >
            <HamburgerIcon />
          </button>
          <span className="flex items-center gap-2 font-semibold text-[#0060BE]">
            <img
              src="/media/logoenea1.png"
              alt="ENEA"
              className="h-8 w-auto"
              onError={(e) => {
                (e.currentTarget as HTMLImageElement).style.display = 'none';
              }}
            />
            Newsletter Admin Console
          </span>
          <div className="ml-auto flex items-center gap-3 text-sm">
            {display && (
              <span
                className="flex items-center gap-2 text-slate-600 dark:text-slate-300"
                title={me.data?.email ?? ''}
              >
                <span
                  aria-hidden
                  className="w-6 h-6 rounded-full bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900 text-xs flex items-center justify-center font-medium"
                >
                  {display.slice(0, 1).toUpperCase()}
                </span>
                <span className="hidden sm:inline">{display}</span>
              </span>
            )}
            <button
              onClick={toggleTheme}
              aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
              title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
              className="p-2 rounded text-slate-500 hover:text-slate-900 hover:bg-slate-100 dark:hover:text-slate-100 dark:hover:bg-slate-800"
            >
              {theme === 'dark' ? <SunIcon /> : <MoonIcon />}
            </button>
            <button
              onClick={logoutAccess}
              className="text-slate-500 hover:text-slate-900 border border-slate-200 rounded px-2 py-1 dark:text-slate-300 dark:hover:text-slate-100 dark:border-slate-700"
            >
              Logout
            </button>
          </div>
        </div>
      </header>

      <div className="flex flex-1 min-h-0">
        <aside
          className={`shrink-0 border-r border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900 overflow-hidden transition-all duration-200 ${
            open ? 'w-56' : 'w-0'
          }`}
        >
          <nav className="w-56 h-full flex flex-col gap-1 p-3 text-base">
            {navLinks.map((item) => (
              <NavLink key={item.to} to={item.to} end={item.end} className={navCls}>
                {item.label}
              </NavLink>
            ))}
          </nav>
        </aside>

        <main className="flex-1 min-w-0 overflow-y-auto px-4 py-6">
          <div className={`${contentWidth} w-full mx-auto`}>
            <Outlet />
          </div>
        </main>
      </div>

      <Footer />
    </div>
  );
}

const APP_VERSION = '1.0';
const LAST_UPDATED = 'Jun 15, 2026';   

function Footer() {
  return (
    <footer className="shrink-0 border-t border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900 px-4 py-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-500 dark:text-slate-400">
        <span className="flex items-center gap-x-4 gap-y-1 flex-wrap">
          <span>Last updated {LAST_UPDATED}</span>
          <span aria-hidden>·</span>
          <span>v{APP_VERSION}</span>
        </span>
        <span aria-hidden>·</span>
        <span className="flex items-center gap-1">
          Built with
          <HeartIcon />
          on Cloudflare by Davide Grandis (davideg@cloudflare.com)
        </span>
      </div>
    </footer>
  );
}

function NoAccess({ email }: { email: string | null }) {
  return (
    <div className="h-screen flex flex-col items-center justify-center gap-4 p-6 text-center bg-slate-50 dark:bg-slate-950">
      <img
        src="/media/logoenea1.png"
        alt="ENEA"
        className="h-10 w-auto"
        onError={(e) => {
          (e.currentTarget as HTMLImageElement).style.display = 'none';
        }}
      />
      <div className="max-w-md space-y-2">
        <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100">No console access</h1>
        <p className="text-sm text-slate-600 dark:text-slate-300">
          {email ? <span className="font-medium">{email}</span> : 'Your account'} is signed in but has
          not been granted access to the Newsletter Admin Console. Ask a super admin to add you.
        </p>
      </div>
      <button
        onClick={logoutAccess}
        className="text-sm rounded border border-slate-300 px-3 py-1.5 text-slate-600 hover:text-slate-900 dark:border-slate-700 dark:text-slate-300 dark:hover:text-slate-100"
      >
        Sign out
      </button>
    </div>
  );
}

function SetupRequiredModal({
  missingAccess,
  missingDomain,
  onAddSettings,
  onLogout,
}: {
  missingAccess: boolean;
  missingDomain: boolean;
  onAddSettings: () => void;
  onLogout: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4">
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="setup-title"
        className="w-full max-w-md rounded-lg bg-white shadow-xl dark:bg-slate-900 border border-slate-200 dark:border-slate-700"
      >
        <div className="p-5 space-y-3">
          <div className="flex items-center gap-2 text-amber-600 dark:text-amber-400">
            <WarningIcon />
            <h2 id="setup-title" className="text-base font-semibold text-slate-900 dark:text-slate-100">
              Required settings not configured
            </h2>
          </div>
          <p className="text-sm text-slate-600 dark:text-slate-300">
            Some mandatory settings still need to be set before the console works correctly:
          </p>
          <ul className="text-sm text-slate-600 dark:text-slate-300 list-disc pl-5 space-y-1">
            {missingAccess && (
              <li>
                <span className="font-medium">Cloudflare Access login</span> (Account ID and Emails
                list ID) — without it new console users are not synced to the Access login list.
              </li>
            )}
            {missingDomain && (
              <li>
                <span className="font-medium">Sending domain</span> — the domain newsletters send
                from and receive mail on. Sending and routing won’t work until it is set.
              </li>
            )}
          </ul>
          <p className="text-sm text-slate-600 dark:text-slate-300">
            Add them now on the Settings page, or close and log out.
          </p>
        </div>
        <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2 px-5 py-4 border-t border-slate-200 dark:border-slate-700">
          <button
            type="button"
            onClick={onLogout}
            className="text-sm rounded px-3 py-1.5 border border-slate-300 text-slate-600 hover:bg-slate-100 dark:border-slate-600 dark:text-slate-300 dark:hover:bg-slate-800"
          >
            Close and log out
          </button>
          <button
            type="button"
            onClick={onAddSettings}
            className="text-sm rounded px-3 py-1.5 bg-slate-900 text-white hover:bg-slate-800 dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-white"
          >
            Go to Settings
          </button>
        </div>
      </div>
    </div>
  );
}

function WarningIcon() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  );
}

function HeartIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="#ef4444"
      stroke="#ef4444"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-label="love"
      role="img"
    >
      <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 1 0-7.78 7.78L12 21.23l8.84-8.84a5.5 5.5 0 0 0 0-7.78z" />
    </svg>
  );
}

function navCls({ isActive }: { isActive: boolean }) {
  return isActive
    ? 'rounded px-3 py-2 bg-slate-900 text-white font-medium dark:bg-slate-100 dark:text-slate-900'
    : 'rounded px-3 py-2 text-slate-600 hover:text-slate-900 hover:bg-slate-100 dark:text-slate-300 dark:hover:text-slate-100 dark:hover:bg-slate-800';
}

function HamburgerIcon() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <line x1="3" y1="6" x2="21" y2="6" />
      <line x1="3" y1="12" x2="21" y2="12" />
      <line x1="3" y1="18" x2="21" y2="18" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  );
}

function SunIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <circle cx="12" cy="12" r="5" />
      <line x1="12" y1="1" x2="12" y2="3" />
      <line x1="12" y1="21" x2="12" y2="23" />
      <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
      <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
      <line x1="1" y1="12" x2="3" y2="12" />
      <line x1="21" y1="12" x2="23" y2="12" />
      <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
      <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
    </svg>
  );
}
