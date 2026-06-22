import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { useState } from 'react';
import { api, Campaign, Page } from '../api';
import { fmtDate } from '../utils/date';
import { Tooltip } from '../components/Tooltip';
import { PAGE_SIZE, Pagination } from '../components/Pagination';
import { RefreshIcon } from './Dashboard';

export default function Campaigns() {
  const [page, setPage] = useState(0);
  const { data, isLoading, isFetching, refetch } = useQuery({
    queryKey: ['campaigns', page],
    placeholderData: keepPreviousData,
    refetchInterval: 60_000,
    queryFn: () =>
      api<Page<Campaign>>(`/api/campaigns?limit=${PAGE_SIZE}&cursor=${page * PAGE_SIZE}`),
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <h1 className="text-xl font-semibold">Campaigns</h1>
        <button
          type="button"
          onClick={() => refetch()}
          disabled={isFetching}
          className="ml-auto inline-flex items-center gap-1.5 text-sm border border-slate-200 rounded px-3 py-1.5 bg-white hover:bg-slate-50 disabled:opacity-50 dark:bg-slate-900 dark:border-slate-700 dark:hover:bg-slate-800"
        >
          <RefreshIcon spinning={isFetching} />
          Refresh
        </button>
      </div>
      {isLoading ? (
        <div className="text-sm text-slate-500 dark:text-slate-400">Loading…</div>
      ) : (
        <div className="bg-white border border-slate-200 rounded overflow-hidden dark:bg-slate-900 dark:border-slate-800">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-slate-600 dark:bg-slate-800/60 dark:text-slate-300">
              <tr>
                <Th align="left" label="Subject" hint="(click for details)" tip="Campaign email subject line" />
                <Th align="left" label="Newsletter" tip="Newsletter this campaign belongs to" />
                <Th align="left" label="Status" tip="Current lifecycle state of the campaign" />
                <Th align="right" label="Recipients" tip="Total number of subscribers this campaign was sent to" className="px-4" />
                <Th align="right" label="Sent" tip="Emails successfully accepted for delivery" className="px-4" />
                <Th align="right" label="Failed" tip="Emails that failed to send" className="px-4" />
                <Th align="right" label="Bounces" tip="Delivery failures reported by the receiving mail server (detected asynchronously)" className="px-4" />
                <Th align="left" label="Sent at" tip="Date and time the campaign was created" className="px-4" />
              </tr>
            </thead>
            <tbody>
              {data?.items.map((c) => (
                <tr key={c.id} className="border-t border-slate-100 hover:bg-slate-50 dark:border-slate-800 dark:hover:bg-slate-800/50">
                  <td className="p-2">
                    <Link to={`/campaigns/${c.id}`} className="text-slate-900 hover:underline dark:text-slate-100">
                      {c.subject || '(no subject)'}
                    </Link>
                    {c.link_mode === 1 && (
                      <span className="ml-2 text-[10px] uppercase tracking-wide bg-amber-100 text-amber-800 px-1 rounded">link mode</span>
                    )}
                  </td>
                  <td className="p-2 text-slate-500 dark:text-slate-400">{c.newsletter_name ?? '—'}</td>
                  <td className="p-2"><CampaignStatus status={c.status} /></td>
                  <td className="px-4 py-2 text-right">{c.total_recipients}</td>
                  <td className="px-4 py-2 text-right text-emerald-700 dark:text-emerald-400">{c.sent_count}</td>
                  <td className="px-4 py-2 text-right text-red-700 dark:text-red-400">{c.failed_count}</td>
                  <td className="px-4 py-2 text-right text-amber-700 dark:text-amber-400">{c.bounce_count || '—'}</td>
                  <td className="px-4 py-2 text-slate-500 dark:text-slate-400">{fmtDate(c.created_at)}</td>
                </tr>
              ))}
              {data && data.items.length === 0 && (
                <tr><td colSpan={8} className="p-4 text-center text-slate-500 dark:text-slate-400">No campaigns yet.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}
      {!isLoading && (
        <Pagination
          page={page}
          total={data?.total ?? 0}
          itemCount={data?.items.length ?? 0}
          busy={isLoading}
          onPage={setPage}
        />
      )}
    </div>
  );
}


function Th({ align = 'left', label, hint, tip, className = '' }: {
  align?: 'left' | 'center' | 'right';
  label: string;
  hint?: string;
  tip?: string;
  className?: string;
}) {
  const content = tip ? <Tooltip text={tip}><span>{label}</span></Tooltip> : <span>{label}</span>;
  const alignCls = align === 'right' ? 'text-right' : align === 'center' ? 'text-center' : 'text-left';
  return (
    <th className={`p-2 ${alignCls} ${className}`}>
      <span className={`inline-flex items-center gap-1.5 ${align === 'right' ? 'flex-row-reverse' : align === 'center' ? 'justify-center' : ''}`}>
        {content}
        {hint && <span className="font-normal normal-case tracking-normal text-slate-400 dark:text-slate-500">{hint}</span>}
      </span>
    </th>
  );
}

// Coloured badge for a campaign's lifecycle status. Running campaigns
// (`sending`) get an animated pulse so they stand out at a glance.
export function CampaignStatus({ status }: { status: string }) {
  const cls: Record<string, string> = {
    queued: 'bg-slate-100 text-slate-700 dark:bg-slate-700 dark:text-slate-200',
    sending: 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300',
    done: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300',
    failed: 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300',
  };
  const running = status === 'sending';
  return (
    <span
      className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded ${
        cls[status] ?? 'bg-slate-100 text-slate-700 dark:bg-slate-700 dark:text-slate-200'
      }`}
    >
      {running && <span className="h-1.5 w-1.5 rounded-full bg-blue-500 animate-pulse" />}
      {status}
    </span>
  );
}
