import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, Author } from '../api';

export default function Authors({ newsletterId }: { newsletterId: string }) {
  const qc = useQueryClient();
  const base = `/api/newsletters/${newsletterId}/authors`;
  const list = useQuery({
    queryKey: ['authors', newsletterId],
    queryFn: () => api<{ items: Author[] }>(base),
  });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['authors', newsletterId] });
    qc.invalidateQueries({ queryKey: ['newsletter', newsletterId] });
  };

  const add = useMutation({
    mutationFn: (body: { email: string; name?: string | null }) =>
      api(base, { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: refresh,
  });

  const remove = useMutation({
    mutationFn: (email: string) =>
      api(`${base}/${encodeURIComponent(email)}`, { method: 'DELETE' }),
    onSuccess: refresh,
  });

  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [err, setErr] = useState<string | null>(null);

  function onAdd(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    add.mutate(
      { email: email.trim(), name: name.trim() || null },
      {
        onSuccess: () => { setEmail(''); setName(''); },
        onError: (e) => setErr((e as Error).message),
      },
    );
  }

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-base font-medium">Authorized authors</h2>
        <p className="text-sm text-slate-500 mt-1 dark:text-slate-400">
          Inbound emails to this newsletter's address are rejected unless the
          sender's address is listed here. Lookup is case-insensitive.
        </p>
      </div>

      <form onSubmit={onAdd} className="flex flex-wrap items-end gap-2 bg-white border border-slate-200 rounded p-3 dark:bg-slate-900 dark:border-slate-800">
        <div className="flex-1 min-w-[200px]">
          <label className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">Email</label>
          <input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="author@example.com"
            className="block w-full border border-slate-300 rounded px-2 py-1 text-sm mt-0.5 bg-white text-slate-900 dark:bg-slate-800 dark:border-slate-700 dark:text-slate-100"
          />
        </div>
        <div className="flex-1 min-w-[160px]">
          <label className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">Name (optional)</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Display name"
            className="block w-full border border-slate-300 rounded px-2 py-1 text-sm mt-0.5 bg-white text-slate-900 dark:bg-slate-800 dark:border-slate-700 dark:text-slate-100"
          />
        </div>
        <button
          type="submit"
          disabled={add.isPending}
          className="bg-slate-900 text-white text-sm rounded px-3 py-1.5 disabled:opacity-50 dark:bg-slate-100 dark:text-slate-900"
        >
          {add.isPending ? 'Adding…' : 'Add author'}
        </button>
        {err && <div className="basis-full text-xs text-red-600">{err}</div>}
      </form>

      <div className="bg-white border border-slate-200 rounded overflow-hidden dark:bg-slate-900 dark:border-slate-800">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-slate-600 dark:bg-slate-800/60 dark:text-slate-300">
            <tr>
              <th title="Authorized sender address. Inbound mail from this address is accepted (case-insensitive)." className="text-left p-2">Email</th>
              <th title="Author's display name (optional)." className="text-left p-2">Name</th>
              <th title="When this address was added to the allow-list." className="text-left p-2">Added</th>
              <th className="p-2 w-1" />
            </tr>
          </thead>
          <tbody>
            {list.isLoading && (
              <tr><td colSpan={4} className="p-4 text-center text-slate-500 dark:text-slate-400">Loading…</td></tr>
            )}
            {list.data?.items.map((a) => (
              <tr key={a.email} className="border-t border-slate-100 dark:border-slate-800">
                <td className="p-2 font-mono text-xs">{a.email}</td>
                <td className="p-2">{a.name ?? <span className="text-slate-400 dark:text-slate-500">—</span>}</td>
                <td className="p-2 text-slate-500 text-xs dark:text-slate-400">{a.created_at}</td>
                <td className="p-2">
                  <button
                    onClick={() => {
                      if (confirm(`Remove ${a.email} from the allow-list?`)) remove.mutate(a.email);
                    }}
                    className="text-xs text-red-700 hover:underline"
                  >
                    Remove
                  </button>
                </td>
              </tr>
            ))}
            {list.data && list.data.items.length === 0 && (
              <tr>
                <td colSpan={4} className="p-4 text-center text-slate-500 dark:text-slate-400">
                  No authors yet — the ingest worker will reject every inbound email.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
