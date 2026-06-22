import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Fragment, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api, LogRow, Page } from '../api';
import { fmtDate, fmtUtc } from '../utils/date';
import { Tooltip } from '../components/Tooltip';
import { RefreshIcon } from './Dashboard';
import { PAGE_SIZE, Pagination } from '../components/Pagination';

const SOURCES = ['', 'ingest', 'consumer', 'tracker', 'bounce', 'admin', 'cleanup'];
const LEVELS = ['', 'error', 'warn', 'info', 'debug'];

export default function Logs() {
  // `input` is the live text box; `q` is the applied search (on submit).
  const [input, setInput] = useState('');
  const [q, setQ] = useState('');
  const [source, setSource] = useState('');
  const [level, setLevel] = useState('');
  const [page, setPage] = useState(0);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  function toggleExpand(key: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  }

  const logs = useQuery({
    queryKey: ['logs', q, source, level, page],
    placeholderData: keepPreviousData,
    refetchInterval: 60_000,
    queryFn: () => {
      const sp = new URLSearchParams({ limit: String(PAGE_SIZE), cursor: String(page * PAGE_SIZE) });
      if (q) sp.set('q', q);
      if (source) sp.set('source', source);
      if (level) sp.set('level', level);
      return api<Page<LogRow>>(`/api/logs?${sp.toString()}`);
    },
  });

  const items = logs.data?.items ?? [];
  const total = logs.data?.total ?? 0;

  // Any filter/search change resets back to the first page.
  const resetTo = <T,>(setter: (v: T) => void) => (v: T) => {
    setter(v);
    setPage(0);
  };

  const onSearch = (e: FormEvent) => {
    e.preventDefault();
    setQ(input.trim());
    setPage(0);
  };

  const [exporting, setExporting] = useState(false);
  async function onExport() {
    setExporting(true);
    try {
      const sp = new URLSearchParams();
      if (q) sp.set('q', q);
      if (source) sp.set('source', source);
      if (level) sp.set('level', level);
      const res = await fetch(`/api/logs/export?${sp.toString()}`);
      if (!res.ok) throw new Error(`export failed (${res.status})`);
      const blob = await res.blob();
      const href = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = href;
      a.download = `logs-${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(href);
    } finally {
      setExporting(false);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <div className="flex items-center justify-between">
          <h1 className="text-xl font-semibold">Logs</h1>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onExport}
              disabled={exporting}
              className="text-sm bg-white border border-slate-200 rounded px-3 py-1.5 hover:bg-slate-50 disabled:opacity-50 dark:bg-slate-900 dark:border-slate-700 dark:hover:bg-slate-800"
            >
              {exporting ? 'Exporting…' : 'Export CSV'}
            </button>
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
          onChange={(e) => resetTo(setSource)(e.target.value)}
          className="border border-slate-300 rounded px-2 py-1.5 text-sm bg-white text-slate-900 dark:bg-slate-800 dark:border-slate-700 dark:text-slate-100"
        >
          {SOURCES.map((s) => (
            <option key={s} value={s}>{s ? s : 'All sources'}</option>
          ))}
        </select>
        <select
          value={level}
          onChange={(e) => resetTo(setLevel)(e.target.value)}
          className="border border-slate-300 rounded px-2 py-1.5 text-sm bg-white text-slate-900 dark:bg-slate-800 dark:border-slate-700 dark:text-slate-100"
        >
          {LEVELS.map((l) => (
            <option key={l} value={l}>{l ? `${l}+` : 'All levels'}</option>
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
            <table className="w-full text-sm table-fixed">
              <thead className="bg-slate-50 text-slate-600 dark:bg-slate-800/60 dark:text-slate-300">
                <tr>
                  <Th label="Time" tip="Date and time of the log entry (UTC)" className="whitespace-nowrap w-44" />
                  <Th label="Level" tip="Severity: debug, info, warn or error" className="w-16" />
                  <Th label="Newsletter" tip="Newsletter this entry is associated with" className="w-36" />
                  <Th label="Campaign" tip="Campaign this entry is associated with" className="w-72" />
                  <Th label="Source" tip="Worker that produced this log entry (ingest, consumer, tracker, bounce, admin, cleanup)" className="w-24" />
                  <Th label="Event" tip="Machine-readable event code, e.g. queue.enqueued or send.bounced" className="w-40" />
                  <Th label="Description" tip="Human-readable summary. Click a row to expand the full detail payload." />
                </tr>
              </thead>
              <tbody>
                {items.map((r) => {
                  const key = `${r.kind}-${r.id}`;
                  const isTrackerClick = r.kind === 'event' && r.source === 'tracker' && r.event === 'click';
                  const hasDetail = (r.kind === 'log' && !!r.detail) || (isTrackerClick && !!r.detail);
                  const isOpen = expanded.has(key);
                  const description = isTrackerClick
                    ? (r.email ?? '—')
                    : (r.message ?? (r.kind === 'event' ? [r.email, r.detail].filter(Boolean).join(' — ') : '—'));
                  return (
                    <Fragment key={key}>
                      <tr
                        className={`border-t border-slate-100 align-top dark:border-slate-800 ${
                          hasDetail ? 'cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800/50' : ''
                        }`}
                        onClick={hasDetail ? () => toggleExpand(key) : undefined}
                      >
                        <td className="px-3 py-1 whitespace-nowrap overflow-hidden text-slate-500 dark:text-slate-400">
                          <Tooltip text={fmtUtc(r.ts)}>{fmtDate(r.ts)}</Tooltip>
                        </td>
                        <td className="px-3 py-1"><LevelBadge level={r.level} /></td>
                        <td className="px-3 py-1 overflow-hidden text-slate-600 dark:text-slate-300"><span className="block truncate">{r.newsletter_name ?? '—'}</span></td>
                        <td className="px-3 py-1 overflow-hidden">
                          {r.campaign_id ? (
                            <Link to={`/campaigns/${r.campaign_id}`} className="block truncate text-slate-500 hover:underline dark:text-slate-400" onClick={(e) => e.stopPropagation()}>
                              {r.campaign_subject || '(no subject)'}
                            </Link>
                          ) : (
                            <span className="text-slate-400 dark:text-slate-600">—</span>
                          )}
                        </td>
                        <td className="px-3 py-1 overflow-hidden text-slate-500 dark:text-slate-400"><span className="block truncate">{r.source}</span></td>
                        <td className="px-3 py-1 overflow-hidden"><span className="block truncate">{r.event}</span></td>
                        <td className="px-3 py-1 text-slate-700 dark:text-slate-200">
                          <div className="flex items-start gap-1.5">
                            {hasDetail && (
                              <span className="mt-0.5 shrink-0 text-slate-400 dark:text-slate-500">{isOpen ? '▾' : '▸'}</span>
                            )}
                            <span>{description}</span>
                          </div>
                        </td>
                      </tr>
                      {isOpen && hasDetail && (
                        <tr className="border-t border-slate-100 bg-slate-50 dark:border-slate-800 dark:bg-slate-800/40">
                          <td colSpan={7} className="px-6 py-2">
                            {isTrackerClick ? (
                              <a href={r.detail!} target="_blank" rel="noopener noreferrer" className="text-xs text-blue-600 dark:text-blue-400 break-all hover:underline">
                                {r.detail}
                              </a>
                            ) : (
                              <pre className="text-xs text-slate-700 dark:text-slate-300 whitespace-pre-wrap break-all font-mono">
                                {JSON.stringify(JSON.parse(r.detail!), null, 2)}
                              </pre>
                            )}
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
                {items.length === 0 && (
                  <tr><td colSpan={7} className="p-4 text-center text-slate-500 dark:text-slate-400">No log entries match.</td></tr>
                )}
              </tbody>
            </table>
          </div>

          <Pagination page={page} total={total} itemCount={items.length} busy={logs.isFetching} onPage={setPage} />
        </>
      )}
    </div>
  );
}


function Th({ label, tip, className = '' }: { label: string; tip: string; className?: string }) {
  return (
    <th className={`text-left px-3 py-2 ${className}`}>
      <Tooltip text={tip}><span>{label}</span></Tooltip>
    </th>
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
