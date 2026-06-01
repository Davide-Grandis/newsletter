import { FormEvent, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, Page, Subscriber } from '../api';
import { SortIcon } from './Newsletters';

type SortKey = 'email' | 'name' | 'status' | 'verified' | 'bounce_count' | 'subscribed_at';
type ImportResult = { added: number; duplicated: number };

export default function Subscribers({ newsletterId }: { newsletterId: string }) {
  const qc = useQueryClient();
  const base = `/api/newsletters/${newsletterId}/subscribers`;
  const [status, setStatus] = useState('');
  const [q, setQ] = useState('');
  const [cursor, setCursor] = useState<number>(0);
  const [sort, setSort] = useState<{ key: SortKey; dir: 'asc' | 'desc' }>({ key: 'email', dir: 'asc' });
  const [importResult, setImportResult] = useState<ImportResult | null>(null);

  const list = useQuery({
    queryKey: ['subs', newsletterId, status, q, cursor],
    queryFn: () => {
      const sp = new URLSearchParams({ limit: '50', cursor: String(cursor) });
      if (status) sp.set('status', status);
      if (q) sp.set('q', q);
      return api<Page<Subscriber>>(`${base}?${sp.toString()}`);
    },
  });

  const rows = useMemo(() => {
    const arr = [...(list.data?.items ?? [])];
    const { key, dir } = sort;
    arr.sort((a, b) => {
      if (key === 'bounce_count' || key === 'verified') {
        return Number(a[key] ?? 0) - Number(b[key] ?? 0);
      }
      return String(a[key] ?? '').localeCompare(String(b[key] ?? ''), undefined, { sensitivity: 'base' });
    });
    return dir === 'desc' ? arr.reverse() : arr;
  }, [list.data, sort]);

  function toggleSort(key: SortKey) {
    setSort((s) => (s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' }));
  }

  const add = useMutation({
    mutationFn: (vars: { email: string; name?: string }) =>
      api(base, { method: 'POST', body: JSON.stringify(vars) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['subs', newsletterId] }),
  });

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
      qc.invalidateQueries({ queryKey: ['subs', newsletterId] });
    },
  });

  function onAdd(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const email = String(fd.get('email') ?? '').trim();
    const name = String(fd.get('name') ?? '').trim() || undefined;
    if (!email) return;
    add.mutate({ email, name });
    e.currentTarget.reset();
  }

  const [exporting, setExporting] = useState(false);
  async function onExport() {
    setExporting(true);
    try {
      const sp = new URLSearchParams();
      if (status) sp.set('status', status);
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
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <h2 className="text-base font-medium">Subscribers</h2>
        <button
          type="button"
          onClick={onExport}
          disabled={exporting}
          className="ml-auto text-sm bg-white border border-slate-200 rounded px-3 py-1.5 hover:bg-slate-50 disabled:opacity-50 dark:bg-slate-900 dark:border-slate-700 dark:hover:bg-slate-800"
        >
          {exporting ? 'Exporting…' : 'Export CSV'}
        </button>
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
      </div>

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

      <form onSubmit={onAdd} className="bg-white border border-slate-200 rounded p-3 flex gap-2 dark:bg-slate-900 dark:border-slate-800">
        <input name="email" type="email" required placeholder="email@example.com" className={inputCls + ' flex-1'} />
        <input name="name" placeholder="name (optional)" className={inputCls + ' flex-1'} />
        <button className="bg-slate-900 text-white text-sm rounded px-3 py-1 dark:bg-slate-100 dark:text-slate-900">Add</button>
      </form>

      <div className="flex gap-2">
        <select value={status} onChange={(e) => { setStatus(e.target.value); setCursor(0); }} className={inputCls}>
          <option value="">All statuses</option>
          <option value="active">Active</option>
          <option value="unsubscribed">Unsubscribed</option>
          <option value="bounced">Bounced</option>
          <option value="complained">Complained</option>
        </select>
        <input
          value={q}
          onChange={(e) => { setQ(e.target.value); setCursor(0); }}
          placeholder="Search email or name"
          className={inputCls + ' flex-1'}
        />
      </div>

      <div className="bg-white border border-slate-200 rounded overflow-hidden dark:bg-slate-900 dark:border-slate-800">
        <table className="w-full table-fixed text-sm">
          <thead className="bg-slate-50 text-slate-600 dark:bg-slate-800/60 dark:text-slate-300">
            <tr>
              <Th label="Email" sortKey="email" sort={sort} onSort={toggleSort} className="w-[30%]" />
              <Th label="Name" sortKey="name" sort={sort} onSort={toggleSort} className="w-[30%]" />
              <Th label="Status" sortKey="status" sort={sort} onSort={toggleSort} className="w-[9%]" />
              <Th label="Verified" sortKey="verified" sort={sort} onSort={toggleSort} className="w-[8%]" />
              <Th label="Bounces" sortKey="bounce_count" sort={sort} onSort={toggleSort} align="right" className="w-[9%]" />
              <Th label="Date subscribed" sortKey="subscribed_at" sort={sort} onSort={toggleSort} className="w-[14%]" />
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
                <td className="p-2 text-right">{s.bounce_count}</td>
                <td className="p-2 truncate">{s.subscribed_at}</td>
              </tr>
            ))}
            {list.data && rows.length === 0 && (
              <tr><td colSpan={6} className="p-4 text-center text-slate-500 dark:text-slate-400">No results.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="flex gap-2 justify-end text-sm">
        <button
          onClick={() => setCursor(0)}
          disabled={cursor === 0}
          className={pagerCls}
        >First</button>
        <button
          onClick={() => list.data?.nextCursor && setCursor(Number(list.data.nextCursor))}
          disabled={!list.data?.nextCursor}
          className={pagerCls}
        >Next →</button>
      </div>
    </div>
  );
}

function Th({
  label,
  sortKey,
  sort,
  onSort,
  align = 'left',
  className = '',
}: {
  label: string;
  sortKey: SortKey;
  sort: { key: SortKey; dir: 'asc' | 'desc' };
  onSort: (key: SortKey) => void;
  align?: 'left' | 'right';
  className?: string;
}) {
  const active = sort.key === sortKey;
  return (
    <th className={`p-2 ${align === 'right' ? 'text-right' : 'text-left'} ${className}`}>
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
    </th>
  );
}

const inputCls =
  'border border-slate-300 rounded px-2 py-1 text-sm bg-white text-slate-900 dark:bg-slate-800 dark:border-slate-700 dark:text-slate-100';

const pagerCls =
  'border border-slate-200 rounded px-3 py-1 disabled:opacity-40 dark:border-slate-700';

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
