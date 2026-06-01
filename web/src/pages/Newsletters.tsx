import { FormEvent, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api, Newsletter } from '../api';

type SortKey = 'name' | 'inbound_address' | 'subscriber_count' | 'author_count' | 'enabled';

export default function Newsletters() {
  const qc = useQueryClient();
  const [err, setErr] = useState<string | null>(null);
  const [warn, setWarn] = useState<string | null>(null);
  const [sort, setSort] = useState<{ key: SortKey; dir: 'asc' | 'desc' }>({ key: 'name', dir: 'asc' });
  const [showSearch, setShowSearch] = useState(false);
  const [query, setQuery] = useState('');

  const list = useQuery({
    queryKey: ['newsletters'],
    queryFn: () => api<{ items: Newsletter[] }>('/api/newsletters'),
  });

  const items = useMemo(() => {
    const q = query.trim().toLowerCase();
    const arr = (list.data?.items ?? []).filter(
      (n) => !q || n.name.toLowerCase().includes(q) || n.inbound_address.toLowerCase().includes(q),
    );
    const { key, dir } = sort;
    arr.sort((a, b) => {
      if (key === 'name' || key === 'inbound_address') {
        return String(a[key] ?? '').localeCompare(String(b[key] ?? ''), undefined, { sensitivity: 'base' });
      }
      return Number(a[key] ?? 0) - Number(b[key] ?? 0);
    });
    return dir === 'desc' ? arr.reverse() : arr;
  }, [list.data, sort, query]);

  function toggleSort(key: SortKey) {
    setSort((s) => (s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' }));
  }

  const create = useMutation({
    mutationFn: (body: { name: string; inbound_address: string }) =>
      api<{ routing_warning?: string }>('/api/newsletters', { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: (res) => {
      setWarn(res.routing_warning ?? null);
      qc.invalidateQueries({ queryKey: ['newsletters'] });
    },
  });

  const toggle = useMutation({
    mutationFn: (vars: { id: string; enabled: boolean }) =>
      api(`/api/newsletters/${vars.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ enabled: vars.enabled }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['newsletters'] }),
  });

  function onCreate(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setErr(null);
    const fd = new FormData(e.currentTarget);
    const name = String(fd.get('name') ?? '').trim();
    const inbound_address = String(fd.get('inbound_address') ?? '').trim();
    if (!name || !inbound_address) return;
    const form = e.currentTarget;
    create.mutate(
      { name, inbound_address },
      {
        onSuccess: () => form.reset(),
        onError: (e) => setErr((e as Error).message),
      },
    );
  }

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Newsletters</h1>

      {warn && (
        <div className="flex items-start gap-2 text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded p-2 dark:text-amber-300 dark:bg-amber-900/30 dark:border-amber-800/60">
          <span className="flex-1">{warn}</span>
          <button onClick={() => setWarn(null)} className="text-amber-600 hover:underline dark:text-amber-400">dismiss</button>
        </div>
      )}

      <form
        onSubmit={onCreate}
        className="flex flex-wrap items-end gap-2 bg-white border border-slate-200 rounded p-3 dark:bg-slate-900 dark:border-slate-800"
      >
        <div className="flex-1 min-w-[160px]">
          <label className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">Name</label>
          <input name="name" required placeholder="Weekly digest" className={inputCls} />
        </div>
        <div className="flex-1 min-w-[220px]">
          <label className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">Inbound address</label>
          <input
            name="inbound_address"
            type="email"
            required
            placeholder="digest@eneanewsletter.it"
            className={inputCls}
          />
        </div>
        <button
          type="submit"
          disabled={create.isPending}
          className="bg-slate-900 text-white text-sm rounded px-3 py-1.5 disabled:opacity-50 dark:bg-slate-100 dark:text-slate-900"
        >
          {create.isPending ? 'Creating…' : 'Add newsletter'}
        </button>
        {err && <div className="basis-full text-xs text-red-600">{err}</div>}
      </form>

      <div className="flex items-center justify-end gap-2">
        {showSearch && (
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search name or address…"
            className="w-56 border border-slate-300 rounded px-2 py-1 text-sm bg-white text-slate-900 dark:bg-slate-800 dark:border-slate-700 dark:text-slate-100"
          />
        )}
        <button
          type="button"
          aria-label="Search"
          onClick={() => {
            setShowSearch((v) => {
              if (v) setQuery('');
              return !v;
            });
          }}
          className={`inline-flex items-center justify-center rounded border p-1.5 ${
            showSearch
              ? 'border-slate-300 bg-slate-100 text-slate-900 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-100'
              : 'border-slate-200 bg-white text-slate-500 hover:text-slate-900 dark:bg-slate-800 dark:border-slate-700 dark:text-slate-300 dark:hover:text-slate-100'
          }`}
        >
          <SearchIcon />
        </button>
      </div>

      <div className="bg-white border border-slate-200 rounded overflow-hidden dark:bg-slate-900 dark:border-slate-800">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-slate-600 dark:bg-slate-800/60 dark:text-slate-300">
            <tr>
              <Th label="Name" hint="(click to edit)" sortKey="name" sort={sort} onSort={toggleSort} className="w-1/4" />
              <Th label="Inbound address" sortKey="inbound_address" sort={sort} onSort={toggleSort} className="w-1/4" />
              <Th label="Subscribers" sortKey="subscriber_count" sort={sort} onSort={toggleSort} align="right" />
              <Th label="Authors" sortKey="author_count" sort={sort} onSort={toggleSort} align="right" />
              <Th label="Enabled" sortKey="enabled" sort={sort} onSort={toggleSort} align="right" />
            </tr>
          </thead>
          <tbody>
            {list.isLoading && (
              <tr><td colSpan={5} className="p-4 text-center text-slate-500 dark:text-slate-400">Loading…</td></tr>
            )}
            {items.map((n) => (
              <tr key={n.id} className="border-t border-slate-100 dark:border-slate-800">
                <td className="p-2">
                  <Link to={`/newsletters/${n.id}`} className="font-medium text-slate-900 hover:underline dark:text-slate-100">
                    {n.name}
                  </Link>
                </td>
                <td className="p-2 font-mono text-xs truncate">{n.inbound_address}</td>
                <td className="p-2 text-right">
                  {n.active_count ?? 0}
                  <span className="text-slate-400 dark:text-slate-500"> / {n.subscriber_count ?? 0}</span>
                </td>
                <td className="p-2 text-right">{n.author_count ?? 0}</td>
                <td className="p-2 text-right">
                  <Toggle
                    on={n.enabled === 1}
                    busy={toggle.isPending}
                    onChange={(enabled) => toggle.mutate({ id: n.id, enabled })}
                  />
                </td>
              </tr>
            ))}
            {list.data && items.length === 0 && (
              <tr><td colSpan={5} className="p-4 text-center text-slate-500 dark:text-slate-400">{query ? 'No matches.' : 'No newsletters yet.'}</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Th({
  label,
  hint,
  sortKey,
  sort,
  onSort,
  align = 'left',
  className = '',
}: {
  label: string;
  hint?: string;
  sortKey: SortKey;
  sort: { key: SortKey; dir: 'asc' | 'desc' };
  onSort: (key: SortKey) => void;
  align?: 'left' | 'right';
  className?: string;
}) {
  const active = sort.key === sortKey;
  return (
    <th className={`p-2 ${align === 'right' ? 'text-right' : 'text-left'} ${className}`}>
      <span className={`inline-flex items-center gap-1.5 ${align === 'right' ? 'flex-row-reverse' : ''}`}>
        <button
          type="button"
          onClick={() => onSort(sortKey)}
          className={`inline-flex items-center gap-1 select-none hover:text-slate-900 dark:hover:text-slate-100 ${
            align === 'right' ? 'flex-row-reverse' : ''
          } ${active ? 'text-slate-900 dark:text-slate-100' : ''}`}
        >
          {label}
          <SortIcon state={active ? sort.dir : 'none'} />
        </button>
        {hint && <span className="font-normal normal-case tracking-normal text-slate-400 dark:text-slate-500">{hint}</span>}
      </span>
    </th>
  );
}

function SortIcon({ state }: { state: 'asc' | 'desc' | 'none' }) {
  if (state === 'none') {
    return (
      <svg width="8" height="11" viewBox="0 0 8 11" className="text-slate-400 dark:text-slate-500" aria-hidden>
        <path d="M4 0 L7 4 L1 4 Z" fill="currentColor" />
        <path d="M4 11 L7 7 L1 7 Z" fill="currentColor" />
      </svg>
    );
  }
  return (
    <svg width="8" height="11" viewBox="0 0 8 11" className="text-orange-500" aria-hidden>
      {state === 'asc' ? (
        <path d="M4 1 L7.5 6 L0.5 6 Z" fill="currentColor" />
      ) : (
        <path d="M4 10 L7.5 5 L0.5 5 Z" fill="currentColor" />
      )}
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="11" cy="11" r="8" />
      <path d="m21 21-4.3-4.3" />
    </svg>
  );
}

export function Toggle({ on, busy, onChange }: { on: boolean; busy?: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      disabled={busy}
      onClick={() => onChange(!on)}
      className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors disabled:opacity-50 ${
        on ? 'bg-emerald-500' : 'bg-slate-300 dark:bg-slate-600'
      }`}
    >
      <span
        className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
          on ? 'translate-x-4' : 'translate-x-1'
        }`}
      />
    </button>
  );
}

const inputCls =
  'block w-full border border-slate-300 rounded px-2 py-1 text-sm mt-0.5 bg-white text-slate-900 dark:bg-slate-800 dark:border-slate-700 dark:text-slate-100';
