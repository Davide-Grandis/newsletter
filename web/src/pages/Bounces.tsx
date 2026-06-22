import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { useState } from 'react';
import { api, BounceEvent, Page } from '../api';
import { RefreshIcon } from './Dashboard';
import { fmtDate } from '../utils/date';
import { Tooltip } from '../components/Tooltip';
import { PAGE_SIZE, Pagination } from '../components/Pagination';


export default function Bounces() {
  const [page, setPage] = useState(0);
  const [exporting, setExporting] = useState(false);

  const bounces = useQuery({
    queryKey: ['bounces', page],
    placeholderData: keepPreviousData,
    refetchInterval: 60_000,
    queryFn: () =>
      api<Page<BounceEvent>>(`/api/bounces?limit=${PAGE_SIZE}&cursor=${page * PAGE_SIZE}`),
  });

  const items = bounces.data?.items ?? [];
  const total = bounces.data?.total ?? 0;

  async function onExport() {
    setExporting(true);
    try {
      const res = await fetch('/api/bounces/export');
      if (!res.ok) throw new Error(`export failed (${res.status})`);
      const blob = await res.blob();
      const href = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = href;
      a.download = `bounces-${new Date().toISOString().slice(0, 10)}.csv`;
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
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Recent bounces (last 7 days)</h1>
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
            onClick={() => bounces.refetch()}
            disabled={bounces.isFetching}
            className="inline-flex items-center gap-1.5 text-sm border border-slate-200 rounded px-3 py-1.5 bg-white hover:bg-slate-50 disabled:opacity-50 dark:bg-slate-900 dark:border-slate-700 dark:hover:bg-slate-800"
          >
            <RefreshIcon spinning={bounces.isFetching} />
            Refresh
          </button>
        </div>
      </div>

      {bounces.isLoading ? (
        <div className="text-sm text-slate-500 dark:text-slate-400">Loading…</div>
      ) : bounces.error ? (
        <div className="text-sm text-red-600">{(bounces.error as Error).message}</div>
      ) : (
        <>
          <div className="bg-white border border-slate-200 rounded overflow-x-auto dark:bg-slate-900 dark:border-slate-800">
            <table className="w-full min-w-[64rem] text-sm">
              <thead className="bg-slate-50 text-slate-600 dark:bg-slate-800/60 dark:text-slate-300">
                <tr>
                  <Th label="Time" tip="Date and time the bounce was recorded (UTC)" className="whitespace-nowrap" />
                  <Th label="Campaign" tip="Campaign the bounced email was part of" className="min-w-[18rem]" />
                  <Th label="Email" tip="Recipient address that bounced" className="min-w-[12rem]" />
                  <Th label="Status" tip="SMTP or enhanced status code returned by the receiving mail server" />
                </tr>
              </thead>
              <tbody>
                {items.map((b) => (
                  <tr key={b.id} className="border-t border-slate-100 align-top dark:border-slate-800">
                    <td className="px-3 py-1 whitespace-nowrap text-slate-500 dark:text-slate-400">{fmtDate(b.ts)}</td>
                    <td className="px-3 py-1">
                      {b.campaign_id ? (
                        <Link to={`/campaigns/${b.campaign_id}`} className="text-slate-500 hover:underline dark:text-slate-400">
                          {b.campaign_subject || '(no subject)'}
                        </Link>
                      ) : (
                        <span className="text-slate-400 dark:text-slate-600">—</span>
                      )}
                    </td>
                    <td className="px-3 py-1 font-mono text-xs">{b.email ?? `#${b.subscriber_id}`}</td>
                    <td className="px-3 py-1">
                      <span className={`text-xs px-2 py-0.5 rounded ${
                        b.status_code?.startsWith('5') ? 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300' : 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300'
                      }`}>{b.status_code ?? '—'}</span>
                    </td>
                  </tr>
                ))}
                {items.length === 0 && (
                  <tr><td colSpan={4} className="p-4 text-center text-slate-500 dark:text-slate-400">No bounces in the last 7 days.</td></tr>
                )}
              </tbody>
            </table>
          </div>
          <Pagination page={page} total={total} itemCount={items.length} busy={bounces.isFetching} onPage={setPage} />
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
