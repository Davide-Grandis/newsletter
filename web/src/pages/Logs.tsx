import { useInfiniteQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { useState, type FormEvent } from 'react';
import { api, LogRow, Page } from '../api';
import { RefreshIcon } from './Dashboard';

const SOURCES = ['', 'ingest', 'consumer', 'tracker', 'bounce', 'admin'];
const LEVELS = ['', 'info', 'warn', 'error'];

export default function Logs() {
  // `input` is the live text box; `q` is the applied search (on submit).
  const [input, setInput] = useState('');
  const [q, setQ] = useState('');
  const [source, setSource] = useState('');
  const [level, setLevel] = useState('');

  const logs = useInfiniteQuery({
    queryKey: ['logs', q, source, level],
    initialPageParam: 0,
    queryFn: ({ pageParam }) => {
      const sp = new URLSearchParams({ limit: '50', cursor: String(pageParam) });
      if (q) sp.set('q', q);
      if (source) sp.set('source', source);
      if (level) sp.set('level', level);
      return api<Page<LogRow>>(`/api/logs?${sp.toString()}`);
    },
    getNextPageParam: (last) => (typeof last.nextCursor === 'number' ? last.nextCursor : undefined),
  });

  const items = logs.data?.pages.flatMap((p) => p.items) ?? [];

  const onSearch = (e: FormEvent) => {
    e.preventDefault();
    setQ(input.trim());
  };

  return (
    <div className="space-y-6">
      <div>
        <div className="flex items-center justify-between">
          <h1 className="text-xl font-semibold">Logs</h1>
          <button
            type="button"
            onClick={() => logs.refetch()}
            disabled={logs.isFetching}
            className="inline-flex items-center gap-1.5 text-sm border border-slate-200 rounded px-3 py-1.5 bg-white hover:bg-slate-50 disabled:opacity-50 dark:bg-slate-900 dark:border-slate-700 dark:hover:bg-slate-800"
          >
            <RefreshIcon spinning={logs.isFetching} />
            Refresh
          </button>
        </div>
        <p className="mt-3 text-sm text-slate-500 dark:text-slate-400 max-w-3xl">
          Unified activity feed across the whole pipeline: the ingest worker firing on inbound
          email, queue enqueue details, and consumer send activity — merged with recipient
          engagement events (open, click, bounce, unsubscribe, download).
        </p>
      </div>

      <form onSubmit={onSearch} className="flex flex-wrap items-center gap-2">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Search event, message, email, campaign…"
          className="flex-1 min-w-[16rem] border border-slate-300 rounded px-3 py-1.5 text-sm bg-white text-slate-900 dark:bg-slate-800 dark:border-slate-700 dark:text-slate-100"
        />
        <select
          value={source}
          onChange={(e) => setSource(e.target.value)}
          className="border border-slate-300 rounded px-2 py-1.5 text-sm bg-white text-slate-900 dark:bg-slate-800 dark:border-slate-700 dark:text-slate-100"
        >
          {SOURCES.map((s) => (
            <option key={s} value={s}>{s ? s : 'All sources'}</option>
          ))}
        </select>
        <select
          value={level}
          onChange={(e) => setLevel(e.target.value)}
          className="border border-slate-300 rounded px-2 py-1.5 text-sm bg-white text-slate-900 dark:bg-slate-800 dark:border-slate-700 dark:text-slate-100"
        >
          {LEVELS.map((l) => (
            <option key={l} value={l}>{l ? l : 'All levels'}</option>
          ))}
        </select>
        <button
          type="submit"
          className="text-sm border border-slate-200 rounded px-3 py-1.5 bg-white hover:bg-slate-50 dark:bg-slate-900 dark:border-slate-700 dark:hover:bg-slate-800"
        >
          Search
        </button>
      </form>

      {logs.isLoading ? (
        <div className="text-sm text-slate-500 dark:text-slate-400">Loading…</div>
      ) : logs.error ? (
        <div className="text-sm text-red-600">{(logs.error as Error).message}</div>
      ) : (
        <>
          <div className="bg-white border border-slate-200 rounded overflow-hidden dark:bg-slate-900 dark:border-slate-800">
            <table className="w-full text-base">
              <thead className="bg-slate-50 text-slate-600 dark:bg-slate-800/60 dark:text-slate-300">
                <tr>
                  <th className="text-left p-3 whitespace-nowrap">Time (UTC)</th>
                  <th className="text-left p-3">Level</th>
                  <th className="text-left p-3">Newsletter</th>
                  <th className="text-left p-3">Campaign</th>
                  <th className="text-left p-3">Source</th>
                  <th className="text-left p-3">Event</th>
                  <th className="text-left p-3">Details</th>
                </tr>
              </thead>
              <tbody>
                {items.map((r) => (
                  <tr key={`${r.kind}-${r.id}`} className="border-t border-slate-100 align-top dark:border-slate-800">
                    <td className="p-3 whitespace-nowrap text-slate-500 dark:text-slate-400">{r.ts}</td>
                    <td className="p-3"><LevelBadge level={r.level} /></td>
                    <td className="p-3 whitespace-nowrap text-slate-600 dark:text-slate-300">{r.newsletter_name ?? '—'}</td>
                    <td className="p-3 whitespace-nowrap">
                      {r.campaign_id ? (
                        <Link to={`/campaigns/${r.campaign_id}`} className="font-mono text-sm text-slate-500 hover:underline dark:text-slate-400">
                          {r.campaign_id.slice(0, 8)}…
                        </Link>
                      ) : (
                        <span className="text-slate-400 dark:text-slate-600">—</span>
                      )}
                    </td>
                    <td className="p-3 text-slate-500 dark:text-slate-400">{r.source}</td>
                    <td className="p-3 font-mono text-sm">{r.event}</td>
                    <td className="p-3 text-slate-700 dark:text-slate-200">
                      {r.message ?? (r.kind === 'event' ? [r.email, r.detail].filter(Boolean).join(' — ') : '—')}
                    </td>
                  </tr>
                ))}
                {items.length === 0 && (
                  <tr><td colSpan={7} className="p-4 text-center text-slate-500 dark:text-slate-400">No log entries match.</td></tr>
                )}
              </tbody>
            </table>
          </div>

          {logs.hasNextPage && (
            <div className="text-center">
              <button
                type="button"
                onClick={() => logs.fetchNextPage()}
                disabled={logs.isFetchingNextPage}
                className="text-sm border border-slate-200 rounded px-4 py-1.5 bg-white hover:bg-slate-50 disabled:opacity-50 dark:bg-slate-900 dark:border-slate-700 dark:hover:bg-slate-800"
              >
                {logs.isFetchingNextPage ? 'Loading…' : 'Load more'}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function LevelBadge({ level }: { level: string }) {
  const cls: Record<string, string> = {
    debug: 'bg-slate-100 text-slate-600 dark:bg-slate-700 dark:text-slate-300',
    info: 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300',
    warn: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300',
    error: 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300',
  };
  return (
    <span className={`text-xs px-2 py-0.5 rounded ${cls[level] ?? cls.info}`}>{level}</span>
  );
}
