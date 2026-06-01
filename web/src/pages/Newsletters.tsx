import { FormEvent, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api, Newsletter } from '../api';

export default function Newsletters() {
  const qc = useQueryClient();
  const [err, setErr] = useState<string | null>(null);
  const [warn, setWarn] = useState<string | null>(null);

  const list = useQuery({
    queryKey: ['newsletters'],
    queryFn: () => api<{ items: Newsletter[] }>('/api/newsletters'),
  });

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

      <div className="bg-white border border-slate-200 rounded overflow-hidden dark:bg-slate-900 dark:border-slate-800">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-slate-600 dark:bg-slate-800/60 dark:text-slate-300">
            <tr>
              <th className="text-left p-2">Name</th>
              <th className="text-left p-2">Inbound address</th>
              <th className="text-right p-2">Subscribers</th>
              <th className="text-right p-2">Authors</th>
              <th className="text-left p-2">Enabled</th>
            </tr>
          </thead>
          <tbody>
            {list.isLoading && (
              <tr><td colSpan={5} className="p-4 text-center text-slate-500 dark:text-slate-400">Loading…</td></tr>
            )}
            {list.data?.items.map((n) => (
              <tr key={n.id} className="border-t border-slate-100 dark:border-slate-800">
                <td className="p-2">
                  <Link to={`/newsletters/${n.id}`} className="font-medium text-slate-900 hover:underline dark:text-slate-100">
                    {n.name}
                  </Link>
                </td>
                <td className="p-2 font-mono text-xs">{n.inbound_address}</td>
                <td className="p-2 text-right">
                  {n.active_count ?? 0}
                  <span className="text-slate-400 dark:text-slate-500"> / {n.subscriber_count ?? 0}</span>
                </td>
                <td className="p-2 text-right">{n.author_count ?? 0}</td>
                <td className="p-2">
                  <Toggle
                    on={n.enabled === 1}
                    busy={toggle.isPending}
                    onChange={(enabled) => toggle.mutate({ id: n.id, enabled })}
                  />
                </td>
              </tr>
            ))}
            {list.data && list.data.items.length === 0 && (
              <tr><td colSpan={5} className="p-4 text-center text-slate-500 dark:text-slate-400">No newsletters yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
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
