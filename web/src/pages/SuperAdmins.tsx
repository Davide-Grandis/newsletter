import { FormEvent, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../api';
import { useIdentity, type Role } from '../auth';
import { ConfirmDialog } from '../components/ConfirmDialog';

interface ConsoleUser {
  email: string;
  role: Role;
}

// Super-admin management, embedded in Settings → "Super admins". Super admins
// have full, unscoped access (settings, all newsletters, all users). Regular
// admins are managed per-newsletter instead, so this view is intentionally
// minimal: email-only add and delete, with backend guards (no self-delete,
// never the last super admin).
export default function SuperAdmins() {
  const qc = useQueryClient();
  const me = useIdentity();

  const [err, setErr] = useState<string | null>(null);
  const [warn, setWarn] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [email, setEmail] = useState('');
  const [toDelete, setToDelete] = useState<string | null>(null);

  const users = useQuery({
    queryKey: ['admins'],
    queryFn: () => api<{ items: ConsoleUser[] }>('/api/admins'),
  });
  const supers = (users.data?.items ?? []).filter((u) => u.role === 'super_admin');

  const add = useMutation({
    mutationFn: () =>
      api<{ list_warning?: string; notify_warning?: string }>('/api/admins', {
        method: 'POST',
        body: JSON.stringify({ email: email.trim().toLowerCase(), role: 'super_admin', newsletter_ids: [] }),
      }),
    onSuccess: (res) => {
      setErr(null);
      setWarn([res.list_warning, res.notify_warning].filter(Boolean).join(' ') || null);
      setAdding(false);
      setEmail('');
      qc.invalidateQueries({ queryKey: ['admins'] });
    },
    onError: (e) => setErr((e as ApiError).message),
  });

  const del = useMutation({
    mutationFn: (target: string) =>
      api<{ list_warning?: string; notify_warning?: string }>(`/api/admins/${encodeURIComponent(target)}`, {
        method: 'DELETE',
      }),
    onSuccess: (res) => {
      setErr(null);
      setWarn([res.list_warning, res.notify_warning].filter(Boolean).join(' ') || null);
      qc.invalidateQueries({ queryKey: ['admins'] });
    },
    onError: (e) => setErr((e as ApiError).message),
  });

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setErr(null);
    if (!email.trim()) {
      setErr('email is required');
      return;
    }
    add.mutate();
  }

  return (
    <>
      {/* Header — matches the section header pattern from Settings */}
      <div className="px-4 py-3 bg-slate-50 border-b border-slate-200 dark:bg-slate-800/60 dark:border-slate-700">
        <h2 className="text-base font-medium">Super admins</h2>
        <p className="text-xs text-slate-500 mt-0.5 dark:text-slate-400">
          Super admins have full access: global settings, every newsletter, and user management.
          Regular admins are added on each newsletter&rsquo;s <strong>Admins</strong> tab. Adding or
          removing a super admin also updates the Cloudflare Access login list.
        </p>
      </div>

      <div className="px-4 py-3 space-y-3">
        <div className="flex justify-end">
          <button
            type="button"
            onClick={() => {
              setErr(null);
              setAdding((v) => !v);
            }}
            className="bg-slate-900 text-white text-sm rounded px-3 py-1.5 dark:bg-slate-100 dark:text-slate-900"
          >
            {adding ? 'Cancel' : 'Add super admin'}
          </button>
        </div>

        {warn && <Banner tone="amber" onDismiss={() => setWarn(null)}>{warn}</Banner>}
        {err && <Banner tone="red" onDismiss={() => setErr(null)}>{err}</Banner>}

        {adding && (
          <form
            onSubmit={onSubmit}
            className="flex flex-wrap items-end gap-2 rounded border border-slate-200 p-3 dark:border-slate-700"
          >
            <div className="flex-1 min-w-[220px]">
              <label className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">Email</label>
              <input
                autoFocus
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="person@example.com"
                className={inputCls}
              />
            </div>
            <button
              type="submit"
              disabled={add.isPending}
              className="bg-slate-900 text-white text-sm rounded px-3 py-1.5 disabled:opacity-50 dark:bg-slate-100 dark:text-slate-900"
            >
              {add.isPending ? 'Adding…' : 'Add'}
            </button>
          </form>
        )}

        <div className="border border-slate-200 rounded overflow-hidden dark:border-slate-700">
          <table className="w-full table-fixed text-sm">
            <thead className="block w-full bg-slate-50 text-slate-600 dark:bg-slate-800/60 dark:text-slate-300">
              <tr className="table w-full table-fixed">
                <th className="px-3 py-2 text-left font-medium w-[80%]">Email</th>
                <th className="px-3 py-2 text-right font-medium w-[20%]">Actions</th>
              </tr>
            </thead>
            <tbody className="block w-full max-h-[205px] overflow-y-auto divide-y divide-slate-100 dark:divide-slate-800">
              {users.isLoading && (
                <tr className="table w-full table-fixed"><td colSpan={2} className="px-3 py-3 text-center text-slate-500 dark:text-slate-400">Loading…</td></tr>
              )}
              {supers.map((u) => (
                <tr key={u.email} className="table w-full table-fixed">
                  <td className="px-3 py-2 font-medium text-slate-900 dark:text-slate-100 w-[80%] truncate">
                    {u.email}
                    {u.email === me.data?.email && (
                      <span className="ml-1 text-xs font-normal text-slate-400">(you)</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right whitespace-nowrap w-[20%]">
                    <button
                      type="button"
                      disabled={u.email === me.data?.email || del.isPending}
                      onClick={() => setToDelete(u.email)}
                      className="text-red-600 hover:underline disabled:opacity-40 disabled:no-underline dark:text-red-400"
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
              {users.data && supers.length === 0 && (
                <tr className="table w-full table-fixed"><td colSpan={2} className="px-3 py-3 text-center text-slate-500 dark:text-slate-400">No super admins.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <ConfirmDialog
        open={toDelete !== null}
        title="Remove super admin?"
        message={<>Remove <span className="font-medium">{toDelete}</span>? They will lose console access.</>}
        confirmLabel="Remove"
        danger
        busy={del.isPending}
        onCancel={() => setToDelete(null)}
        onConfirm={() => {
          if (toDelete) del.mutate(toDelete, { onSettled: () => setToDelete(null) });
        }}
      />
    </>
  );
}

function Banner({
  tone,
  onDismiss,
  children,
}: {
  tone: 'amber' | 'red';
  onDismiss: () => void;
  children: React.ReactNode;
}) {
  const cls =
    tone === 'amber'
      ? 'text-amber-800 bg-amber-50 border-amber-200 dark:text-amber-300 dark:bg-amber-900/30 dark:border-amber-800/60'
      : 'text-red-800 bg-red-50 border-red-200 dark:text-red-300 dark:bg-red-900/30 dark:border-red-800/60';
  return (
    <div className={`flex items-start gap-2 text-xs border rounded p-2 ${cls}`}>
      <span className="flex-1">{children}</span>
      <button onClick={onDismiss} className="hover:underline">dismiss</button>
    </div>
  );
}

const inputCls =
  'block w-full border border-slate-300 rounded px-2 py-1 text-sm mt-0.5 bg-white text-slate-900 dark:bg-slate-800 dark:border-slate-700 dark:text-slate-100';
