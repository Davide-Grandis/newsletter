import { useState } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, Page, Subscriber } from '../api';
import { SortIcon } from './Newsletters';
import { Tooltip } from '../components/Tooltip';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { PAGE_SIZE, Pagination } from '../components/Pagination';
import { fmtDate } from '../utils/date';

type SortKey = 'email' | 'name' | 'status' | 'verified' | 'bounce_count' | 'subscribed_at';
type ImportResult = { added: number; duplicated: number };

export default function Subscribers({
  newsletterId,
  canEdit = true,
}: {
  newsletterId: string;
  // Read-only admins can view and export, but not import (the only mutation here).
  canEdit?: boolean;
}) {
  const qc = useQueryClient();
  const base = `/api/newsletters/${newsletterId}/subscribers`;
  const [status, setStatus] = useState('');
  const [verified, setVerified] = useState('');
  const [bounces, setBounces] = useState('');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(0);
  const [sort, setSort] = useState<{ key: SortKey; dir: 'asc' | 'desc' }>({ key: 'email', dir: 'asc' });
  const [importResult, setImportResult] = useState<ImportResult | null>(null);

  const list = useQuery({
    queryKey: ['subs', newsletterId, status, verified, bounces, q, page, sort.key, sort.dir],
    placeholderData: keepPreviousData,
    queryFn: () => {
      const sp = new URLSearchParams({ limit: String(PAGE_SIZE), cursor: String(page * PAGE_SIZE) });
      if (status) sp.set('status', status);
      if (verified) sp.set('verified', verified);
      if (bounces) sp.set('bounces', bounces);
      if (q) sp.set('q', q);
      sp.set('sort_key', sort.key);
      sp.set('sort_dir', sort.dir);
      return api<Page<Subscriber>>(`${base}?${sp.toString()}`);
    },
  });

  const rows = list.data?.items ?? [];

  function toggleSort(key: SortKey) {
    setSort((s) => (s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' }));
    setPage(0);
  }

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['subs', newsletterId] });
    qc.invalidateQueries({ queryKey: ['newsletter', newsletterId] });
  };

  const upload = useMutation({
    mutationFn: async (file: File) => {
      const text = await file.text();
      return api<ImportResult>(`${base}/import`, {
        method: 'POST',
        body: JSON.stringify({ csv: text }),
      });
    },
    onSuccess: (res) => {
      setImportResult(res);
      refresh();
    },
  });

  const [deleteTarget, setDeleteTarget] = useState<{ id: number; email: string } | null>(null);
  const del = useMutation({
    mutationFn: (subId: number) =>
      api(`${base}/${subId}`, { method: 'DELETE' }),
    onSuccess: () => {
      setDeleteTarget(null);
      refresh();
    },
  });

  const reactivate = useMutation({
    mutationFn: (subId: number) =>
      api(`${base}/${subId}`, { method: 'PATCH', body: JSON.stringify({ status: 'active' }) }),
    onSuccess: refresh,
  });

  const [verifying, setVerifying] = useState<number | null>(null);
  const [verifyError, setVerifyError] = useState<string | null>(null);
  const resend = useMutation({
    mutationFn: (subId: number) =>
      api(`${base}/${subId}/resend-confirmation`, { method: 'POST' }),
    onSettled: (_d, _e, subId) => setVerifying((v) => (v === subId ? null : v)),
    onSuccess: refresh,
    onError: (e) => setVerifyError((e as Error).message),
  });

  const [exporting, setExporting] = useState(false);
  async function onExport() {
    setExporting(true);
    try {
      const sp = new URLSearchParams();
      if (status) sp.set('status', status);
      if (verified) sp.set('verified', verified);
      if (bounces) sp.set('bounces', bounces);
      if (q) sp.set('q', q);
      const res = await fetch(`${base}/export?${sp.toString()}`);
      if (!res.ok) throw new Error(`export failed (${res.status})`);
      const blob = await res.blob();
      const href = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = href;
      a.download = `subscribers-${new Date().toISOString().slice(0, 10)}.csv`;
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
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-base font-medium mr-3">Subscribers</h2>
        <select
          value={status}
          onChange={(e) => { setStatus(e.target.value); setPage(0); }}
          className={inputCls}
        >
          <option value="">All statuses</option>
          <option value="active">Active</option>
          <option value="unsubscribed">Unsubscribed</option>
          <option value="bounced">Bounced</option>
          <option value="complained">Complained</option>
        </select>
        <select
          value={verified}
          onChange={(e) => { setVerified(e.target.value); setPage(0); }}
          className={inputCls}
        >
          <option value="">All</option>
          <option value="true">Verified</option>
          <option value="false">Not verified</option>
        </select>
        <select
          value={bounces}
          onChange={(e) => { setBounces(e.target.value); setPage(0); }}
          className={inputCls}
        >
          <option value="">All bounces</option>
          <option value="0">No bounces</option>
          <option value="gt0">Any bounce</option>
          <option value="hard">Hard (permanent)</option>
          <option value="soft">Soft (transient)</option>
          <option value="block">Block (policy)</option>
        </select>
        <button
          type="button"
          onClick={refresh}
          disabled={list.isFetching}
          className="ml-auto text-sm bg-white border border-slate-200 rounded px-3 py-1.5 hover:bg-slate-50 disabled:opacity-50 dark:bg-slate-900 dark:border-slate-700 dark:hover:bg-slate-800"
        >
          {list.isFetching ? 'Refreshing…' : 'Refresh'}
        </button>
        <Tooltip text="With current filter">
          <button
            type="button"
            onClick={onExport}
            disabled={exporting}
            className="text-sm bg-white border border-slate-200 rounded px-3 py-1.5 hover:bg-slate-50 disabled:opacity-50 dark:bg-slate-900 dark:border-slate-700 dark:hover:bg-slate-800"
          >
            {exporting ? 'Exporting…' : 'Export CSV'}
          </button>
        </Tooltip>
        {canEdit && (
          <Tooltip text="Append mode">
            <label className="text-sm cursor-pointer bg-white border border-slate-200 rounded px-3 py-1.5 hover:bg-slate-50 dark:bg-slate-900 dark:border-slate-700 dark:hover:bg-slate-800">
              Import CSV
              <input
                type="file"
                accept=".csv,text/csv"
                className="hidden"
                onChange={(e) => {
                  const f = e.currentTarget.files?.[0];
                  if (f) upload.mutate(f);
                }}
              />
            </label>
          </Tooltip>
        )}
      </div>

      {verifyError && (
        <div className="flex items-start gap-2 rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-800 dark:bg-red-900/20 dark:text-red-400">
          <span className="flex-1">{verifyError}</span>
          <button type="button" onClick={() => setVerifyError(null)} className="text-red-400 hover:text-red-600 dark:hover:text-red-300">✕</button>
        </div>
      )}

      {importResult && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-sm bg-white rounded-lg shadow-lg p-5 dark:bg-slate-900 dark:border dark:border-slate-700">
            <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">Import complete</h2>
            <div className="mt-3 space-y-1 text-sm text-slate-700 dark:text-slate-200">
              <div>Subscribers added: <span className="font-semibold">{importResult.added}</span></div>
              <div>Duplicated: <span className="font-semibold">{importResult.duplicated}</span></div>
            </div>
            <div className="mt-4 flex justify-end">
              <button
                type="button"
                onClick={() => setImportResult(null)}
                className="text-sm rounded px-3 py-1.5 bg-slate-900 text-white hover:bg-slate-800 dark:bg-slate-100 dark:text-slate-900"
              >
                OK
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <input
          value={q}
          onChange={(e) => { setQ(e.target.value); setPage(0); }}
          placeholder="Search email or name"
          className={inputCls + ' flex-1 min-w-[16rem]'}
        />
      </div>

      <div className="bg-white border border-slate-200 rounded overflow-hidden dark:bg-slate-900 dark:border-slate-800">
        <table className="w-full table-fixed text-sm">
          <thead className="bg-slate-50 text-slate-600 dark:bg-slate-800/60 dark:text-slate-300">
            <tr>
              <Th label="Email" title="Subscriber's email address (unique per newsletter)." sortKey="email" sort={sort} onSort={toggleSort} className="w-[24%]" />
              <Th label="Name" title="Subscriber's display name (optional)." sortKey="name" sort={sort} onSort={toggleSort} className="w-[22%]" />
              <Th label="Status" title="Delivery state: active subscribers receive sends; unsubscribed, bounced and complained are excluded." sortKey="status" sort={sort} onSort={toggleSort} className="w-[9%]" />
              <Th label="Verified" title="Whether the email address has been confirmed. Defaults to False for new subscribers." sortKey="verified" sort={sort} onSort={toggleSort} className="w-[8%]" />
              <Th label="Bounces" title="Number of times mail to this address has bounced." sortKey="bounce_count" sort={sort} onSort={toggleSort} align="right" className="w-[9%]" />
              <Th label="Date subscribed" title="When the subscriber was added to the list." sortKey="subscribed_at" sort={sort} onSort={toggleSort} className="w-[20%] pl-8" />
              <th className="p-2 w-[14%]" />
            </tr>
          </thead>
          <tbody>
            {rows.map((s) => (
              <tr key={s.id} className="border-t border-slate-100 dark:border-slate-800">
                <td className="p-2 font-mono text-xs truncate">{s.email}</td>
                <td className="p-2 truncate">{s.name ?? '—'}</td>
                <td className="p-2">
                  <StatusPill status={s.status} />
                </td>
                <td className="p-2">
                  <span
                    className={`text-xs px-2 py-0.5 rounded ${
                      s.verified === 1
                        ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300'
                        : 'bg-slate-100 text-slate-700 dark:bg-slate-700 dark:text-slate-200'
                    }`}
                  >
                    {s.verified === 1 ? 'True' : 'False'}
                  </span>
                </td>
                <td className="p-2 text-right">
                  <span className="inline-flex items-center gap-1.5 justify-end">
                    {s.last_bounce_type && <BounceTypeBadge type={s.last_bounce_type} code={s.last_bounce_code} />}
                    <span>{s.bounce_count}</span>
                  </span>
                </td>
                <td className="p-2 pl-8 truncate">{fmtDate(s.subscribed_at)}</td>
                <td className="p-2 text-right">
                  {canEdit && (
                    <div className="inline-flex items-center gap-1 justify-end">
                    <Tooltip text="Re-activate (only for bounced and complained)">
                      <button
                        type="button"
                        disabled={s.status !== 'bounced' && s.status !== 'complained' || reactivate.isPending}
                        onClick={() => reactivate.mutate(s.id)}
                        className="inline-flex items-center justify-center w-6 h-6 rounded-full border border-emerald-300 text-emerald-600 text-xs font-semibold hover:bg-emerald-50 disabled:opacity-50 disabled:cursor-not-allowed dark:border-emerald-700 dark:text-emerald-400 dark:hover:bg-emerald-900/20"
                      >
                        R
                      </button>
                    </Tooltip>
                    <Tooltip text="Delete subscriber">
                      <button
                        type="button"
                        onClick={() => setDeleteTarget({ id: s.id, email: s.email })}
                        className="inline-flex items-center justify-center w-6 h-6 rounded-full border border-red-300 text-red-600 text-xs font-semibold hover:bg-red-50 dark:border-red-700 dark:text-red-400 dark:hover:bg-red-900/20"
                      >
                        D
                      </button>
                    </Tooltip>
                    <Tooltip text={s.verified === 1 ? 'Already verified' : 'Send verification email'}>
                      <button
                        type="button"
                        disabled={s.verified === 1 || verifying === s.id || resend.isPending}
                        onClick={() => { setVerifying(s.id); resend.mutate(s.id); }}
                        className="inline-flex items-center justify-center w-6 h-6 rounded-full border border-blue-300 text-blue-600 text-xs font-semibold hover:bg-blue-50 disabled:opacity-50 disabled:cursor-not-allowed dark:border-blue-700 dark:text-blue-400 dark:hover:bg-blue-900/20"
                      >
                        {verifying === s.id ? '…' : 'V'}
                      </button>
                    </Tooltip>
                    </div>
                  )}
                </td>
              </tr>
            ))}
            {list.data && rows.length === 0 && (
              <tr><td colSpan={8} className="p-4 text-center text-slate-500 dark:text-slate-400">No results.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <Pagination
        page={page}
        total={list.data?.total ?? 0}
        itemCount={list.data?.items.length ?? 0}
        busy={list.isFetching}
        onPage={setPage}
      />

      <ConfirmDialog
        open={deleteTarget !== null}
        title="Delete subscriber?"
        message={<>This permanently removes <strong>{deleteTarget?.email}</strong> and all their associated data. This cannot be undone.</>}
        confirmLabel={del.isPending ? 'Deleting…' : 'Delete'}
        danger
        busy={del.isPending}
        onConfirm={() => deleteTarget && del.mutate(deleteTarget.id)}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}

function Th({
  label,
  title,
  sortKey,
  sort,
  onSort,
  align = 'left',
  className = '',
}: {
  label: string;
  title?: string;
  sortKey: SortKey;
  sort: { key: SortKey; dir: 'asc' | 'desc' };
  onSort: (key: SortKey) => void;
  align?: 'left' | 'right';
  className?: string;
}) {
  const active = sort.key === sortKey;
  const button = (
    <button
      type="button"
      onClick={() => onSort(sortKey)}
      className={`inline-flex items-center gap-1 select-none hover:text-slate-900 dark:hover:text-slate-100 ${
        active ? 'text-slate-900 dark:text-slate-100' : ''
      }`}
    >
      {label}
      <SortIcon state={active ? sort.dir : 'none'} />
    </button>
  );
  return (
    <th className={`p-2 ${align === 'right' ? 'text-right' : 'text-left'} ${className}`}>
      {title ? <Tooltip text={title}>{button}</Tooltip> : button}
    </th>
  );
}


const inputCls =
  'border border-slate-300 rounded px-2 py-1 text-sm bg-white text-slate-900 dark:bg-slate-800 dark:border-slate-700 dark:text-slate-100';

export function BounceTypeBadge({
  type,
  code,
}: {
  type: 'hard' | 'soft' | 'block';
  code?: string | null;
}) {
  const cls: Record<string, string> = {
    hard: 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300',
    soft: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300',
    block: 'bg-purple-100 text-purple-800 dark:bg-purple-900/40 dark:text-purple-300',
  };
  const labels: Record<string, string> = {
    hard: 'Hard — permanent failure (e.g. mailbox not found)',
    soft: 'Soft — transient failure (e.g. full mailbox)',
    block: 'Block — reputation/policy rejection',
  };
  const label = labels[type] ?? type;
  const tip = code ? `${label} (${code})` : label;
  return (
    <Tooltip text={tip}>
      <span className={`text-[10px] uppercase px-1.5 py-0.5 rounded font-medium ${cls[type]}`}>
        {type}
      </span>
    </Tooltip>
  );
}

export function StatusPill({ status }: { status: string }) {
  const cls: Record<string, string> = {
    active: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300',
    unsubscribed: 'bg-slate-100 text-slate-700 dark:bg-slate-700 dark:text-slate-200',
    bounced: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300',
    complained: 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300',
  };
  return (
    <span className={`text-xs px-2 py-0.5 rounded ${cls[status] ?? 'bg-slate-100 text-slate-700 dark:bg-slate-700 dark:text-slate-200'}`}>
      {status}
    </span>
  );
}
