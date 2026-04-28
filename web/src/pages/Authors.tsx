import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, Author } from '../api';
import { useAuth } from '../auth';

export default function Authors() {
  const { token } = useAuth();
  const qc = useQueryClient();
  const list = useQuery({
    queryKey: ['authors'],
    queryFn: () => api<{ items: Author[] }>(token!, '/api/authors'),
  });

  const add = useMutation({
    mutationFn: (body: { email: string; name?: string | null }) =>
      api(token!, '/api/authors', { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['authors'] }),
  });

  const remove = useMutation({
    mutationFn: (email: string) =>
      api(token!, `/api/authors/${encodeURIComponent(email)}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['authors'] }),
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
        <h1 className="text-xl font-semibold">Authorized authors</h1>
        <p className="text-sm text-slate-500 mt-1">
          Inbound emails to <code className="bg-slate-100 px-1 rounded">newsletter@…</code> are
          rejected unless the sender's address is listed here. Lookup is case-insensitive.
        </p>
      </div>

      <form onSubmit={onAdd} className="flex flex-wrap items-end gap-2 bg-white border rounded p-3">
        <div className="flex-1 min-w-[200px]">
          <label className="text-xs uppercase tracking-wide text-slate-500">Email</label>
          <input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="author@example.com"
            className="block w-full border rounded px-2 py-1 text-sm mt-0.5"
          />
        </div>
        <div className="flex-1 min-w-[160px]">
          <label className="text-xs uppercase tracking-wide text-slate-500">Name (optional)</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Display name"
            className="block w-full border rounded px-2 py-1 text-sm mt-0.5"
          />
        </div>
        <button
          type="submit"
          disabled={add.isPending}
          className="bg-slate-900 text-white text-sm rounded px-3 py-1.5 disabled:opacity-50"
        >
          {add.isPending ? 'Adding…' : 'Add author'}
        </button>
        {err && <div className="basis-full text-xs text-red-600">{err}</div>}
      </form>

      <div className="bg-white border rounded overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-slate-600">
            <tr>
              <th className="text-left p-2">Email</th>
              <th className="text-left p-2">Name</th>
              <th className="text-left p-2">Added</th>
              <th className="p-2 w-1" />
            </tr>
          </thead>
          <tbody>
            {list.isLoading && (
              <tr><td colSpan={4} className="p-4 text-center text-slate-500">Loading…</td></tr>
            )}
            {list.data?.items.map((a) => (
              <tr key={a.email} className="border-t">
                <td className="p-2 font-mono text-xs">{a.email}</td>
                <td className="p-2">{a.name ?? <span className="text-slate-400">—</span>}</td>
                <td className="p-2 text-slate-500 text-xs">{a.created_at}</td>
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
                <td colSpan={4} className="p-4 text-center text-slate-500">
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
