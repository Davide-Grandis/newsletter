import { useState } from 'react';
import { Navigate, NavLink, Outlet, Route, Routes } from 'react-router-dom';
import { logoutAccess, useIdentity } from './auth';
import { useTheme } from './theme';
import Dashboard from './pages/Dashboard';
import Newsletters from './pages/Newsletters';
import NewsletterDetail from './pages/NewsletterDetail';
import Campaigns from './pages/Campaigns';
import CampaignDetail from './pages/CampaignDetail';
import Bounces from './pages/Bounces';
import Help from './pages/Help';

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
        <Route path="help" element={<Help />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

const NAV_ITEMS = [
  { to: '/', label: 'Dashboard', end: true },
  { to: '/newsletters', label: 'Newsletters', end: false },
  { to: '/campaigns', label: 'Campaigns', end: false },
  { to: '/bounces', label: 'Bounces', end: false },
  { to: '/help', label: 'Help', end: false },
];

function Layout() {
  const me = useIdentity();
  const display = me.data?.name?.trim() || me.data?.email || null;
  const [open, setOpen] = useState(true);
  const { theme, toggle } = useTheme();

  return (
    <div className="h-screen flex flex-col">
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
              onClick={toggle}
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
            {NAV_ITEMS.map((item) => (
              <NavLink key={item.to} to={item.to} end={item.end} className={navCls}>
                {item.label}
              </NavLink>
            ))}
          </nav>
        </aside>

        <main className="flex-1 min-w-0 overflow-y-auto px-4 py-6">
          <div className="max-w-6xl w-full mx-auto">
            <Outlet />
          </div>
        </main>
      </div>

      <Footer />
    </div>
  );
}

const APP_VERSION = '0.1';
const CREATED_DATE = 'Apr 28, 2026';
const LAST_UPDATED = 'Jun 1, 2026';

function Footer() {
  return (
    <footer className="shrink-0 border-t border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900 px-4 py-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-500 dark:text-slate-400">
        <span className="flex items-center gap-x-4 gap-y-1 flex-wrap">
          <span>Created {CREATED_DATE}</span>
          <span aria-hidden>·</span>
          <span>Last updated {LAST_UPDATED}</span>
          <span aria-hidden>·</span>
          <span>v{APP_VERSION}</span>
        </span>
        <span aria-hidden>·</span>
        <span className="flex items-center gap-1">
          Built with
          <HeartIcon />
          on Cloudflare
        </span>
      </div>
    </footer>
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
