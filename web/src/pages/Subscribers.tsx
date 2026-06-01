import { FormEvent, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, Page, Subscriber } from '../api';

export default function Subscribers({ newsletterId }: { newsletterId: string }) {
  const qc = useQueryClient();
  const base = `/api/newsletters/${newsletterId}/subscribers`;
  const [status, setStatus] = useState('');
  const [q, setQ] = useState('');
  const [cursor, setCursor] = useState<number>(0);

  const list = useQuery({
    queryKey: ['subs', newsletterId, status, q, cursor],
    queryFn: () => {
      const sp = new URLSearchParams({ limit: '50', cursor: String(cursor) });
      if (status) sp.set('status', status);
      if (q) sp.set('q', q);
      return api<Page<Subscriber>>(`${base}?${sp.toString()}`);
    },
  });

  const add = useMutation({
    mutationFn: (vars: { email: string; name?: string }) =>
      api(base, { method: 'POST', body: JSON.stringify(vars) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['subs', newsletterId] }),
  });

  const remove = useMutation({
    mutationFn: (id: number) => api(`${base}/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['subs', newsletterId] }),
  });

  const upload = useMutation({
    mutationFn: async (file: File) => {
      const text = await file.text();
      return api<{ inserted: number }>(`${base}/import`, {
        method: 'POST',
        body: JSON.stringify({ csv: text }),
      });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['subs', newsletterId] }),
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

      {upload.data && (
        <div className="text-xs text-emerald-700">Imported {upload.data.inserted} rows.</div>
      )}

      <form onSubmit={onAdd} className="bg-white border border-slate-200 rounded p-3 flex gap-2 dark:bg-slate-900 dark:border-slate-800">
        <input name="email" type="email" required placeholder="email@example.com" className={inputCls + ' flex-1'} />
        <input name="name" placeholder="name (optional)" className={inputCls + ' w-48'} />
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
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-slate-600 dark:bg-slate-800/60 dark:text-slate-300">
            <tr>
              <th className="text-left p-2">Email</th>
              <th className="text-left p-2">Name</th>
              <th className="text-left p-2">Verified</th>
              <th className="text-left p-2">Status</th>
              <th className="text-right p-2">Bounces</th>
              <th className="text-left p-2">Date subscribed</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {list.data?.items.map((s) => (
              <tr key={s.id} className="border-t border-slate-100 dark:border-slate-800">
                <td className="p-2 font-mono text-xs">{s.email}</td>
                <td className="p-2">{s.name ?? '—'}</td>
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
                <td className="p-2">
                  <StatusPill status={s.status} />
                </td>
                <td className="p-2 text-right">{s.bounce_count}</td>
                <td className="p-2 text-slate-500 dark:text-slate-400">{s.subscribed_at}</td>
                <td className="p-2 text-right">
                  <button
                    onClick={() => remove.mutate(s.id)}
                    className="text-xs text-red-600 hover:underline"
                  >
                    unsubscribe
                  </button>
                </td>
              </tr>
            ))}
            {list.data && list.data.items.length === 0 && (
              <tr><td colSpan={7} className="p-4 text-center text-slate-500 dark:text-slate-400">No results.</td></tr>
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
