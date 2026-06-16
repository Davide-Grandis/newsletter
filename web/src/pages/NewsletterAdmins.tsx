import { FormEvent, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../api';
import { useIdentity, type Capability } from '../auth';
import { ConfirmDialog } from '../components/ConfirmDialog';

interface NewsletterAdmin {
  email: string;
  capability: Capability;
}

// Per-newsletter admin management, shown on a newsletter's "Admins" tab.
// Admins are scoped to this newsletter and carry a read-only/edit capability
// (per-admin, so changing it here affects all newsletters they are assigned
// to). `canManage` is true for super admins and edit-admins of this newsletter;
// read-only admins see the list but cannot change it.
export default function NewsletterAdmins({
  newsletterId,
  canManage,
}: {
  newsletterId: string;
  canManage: boolean;
}) {
  const qc = useQueryClient();
  const me = useIdentity();
  const key = ['newsletter-admins', newsletterId];

  const [err, setErr] = useState<string | null>(null);
  const [warn, setWarn] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [email, setEmail] = useState('');
  const [capability, setCapability] = useState<Capability>('read_only');
  const [toRemove, setToRemove] = useState<string | null>(null);
  // Per-row edit mode for changing permission (gated behind an Edit button so it
  // isn't changed accidentally with an always-live dropdown).
  const [editEmail, setEditEmail] = useState<string | null>(null);
  const [editCap, setEditCap] = useState<Capability>('read_only');

  const admins = useQuery({
    queryKey: key,
    queryFn: () => api<{ items: NewsletterAdmin[] }>(`/api/newsletters/${newsletterId}/admins`),
  });
  const items = admins.data?.items ?? [];

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: key });
    qc.invalidateQueries({ queryKey: ['me'] });
  };

  const add = useMutation({
    mutationFn: () =>
      api<{ list_warning?: string; notify_warning?: string }>(`/api/newsletters/${newsletterId}/admins`, {
        method: 'POST',
        body: JSON.stringify({ email: email.trim().toLowerCase(), capability }),
      }),
    onSuccess: (res) => {
      setErr(null);
      setWarn([res.list_warning, res.notify_warning].filter(Boolean).join(' ') || null);
      setAdding(false);
      setEmail('');
      setCapability('read_only');
      invalidate();
    },
    onError: (e) => setErr((e as ApiError).message),
  });

  const setCap = useMutation({
    mutationFn: (vars: { email: string; capability: Capability }) =>
      api(`/api/newsletters/${newsletterId}/admins/${encodeURIComponent(vars.email)}`, {
        method: 'PATCH',
        body: JSON.stringify({ capability: vars.capability }),
      }),
    onSuccess: () => {
      setErr(null);
      invalidate();
    },
    onError: (e) => setErr((e as ApiError).message),
  });

  const remove = useMutation({
    mutationFn: (target: string) =>
      api<{ list_warning?: string; notify_warning?: string; removed_user?: boolean }>(
        `/api/newsletters/${newsletterId}/admins/${encodeURIComponent(target)}`,
        { method: 'DELETE' },
      ),
    onSuccess: (res) => {
      setErr(null);
      setWarn([res.list_warning, res.notify_warning].filter(Boolean).join(' ') || null);
      invalidate();
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

  const busy = add.isPending || setCap.isPending || remove.isPending;

  return (
    <div className="space-y-4">
      <p className="text-sm text-slate-500 dark:text-slate-400">
        Admins manage this newsletter&rsquo;s subscribers, authors and campaigns.{' '}
        <strong>Read-only</strong> admins can view but not change anything; <strong>edit</strong>{' '}
        admins can make changes and manage admins here. New admins default to read-only.
      </p>

      {warn && <Banner tone="amber" onDismiss={() => setWarn(null)}>{warn}</Banner>}
      {err && <Banner tone="red" onDismiss={() => setErr(null)}>{err}</Banner>}

      {canManage && (
        <div className="flex justify-end">
          <button
            type="button"
            onClick={() => {
              setErr(null);
              setAdding((v) => !v);
            }}
            className="bg-slate-900 text-white text-sm rounded px-3 py-1.5 dark:bg-slate-100 dark:text-slate-900"
          >
            {adding ? 'Cancel' : 'Add admin'}
          </button>
        </div>
      )}

      {canManage && adding && (
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
          <div className="min-w-[150px]">
            <label className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">Permission</label>
            <select
              value={capability}
              onChange={(e) => setCapability(e.target.value as Capability)}
              className={inputCls}
            >
              <option value="read_only">read-only</option>
              <option value="edit">edit</option>
            </select>
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

      <div className="bg-white border border-slate-200 rounded overflow-hidden dark:bg-slate-900 dark:border-slate-800">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-slate-600 dark:bg-slate-800/60 dark:text-slate-300">
            <tr>
              <th className="p-2 text-left">Email</th>
              <th className="p-2 text-left">Permission</th>
              {canManage && <th className="p-2 text-right">Actions</th>}
            </tr>
          </thead>
          <tbody>
            {admins.isLoading && (
              <tr><td colSpan={canManage ? 3 : 2} className="p-4 text-center text-slate-500 dark:text-slate-400">Loading…</td></tr>
            )}
            {items.map((u) => (
              <tr key={u.email} className="border-t border-slate-100 dark:border-slate-800">
                <td className="p-2 font-medium text-slate-900 dark:text-slate-100">
                  {u.email}
                  {u.email === me.data?.email && (
                    <span className="ml-1 text-xs font-normal text-slate-400">(you)</span>
                  )}
                </td>
                <td className="p-2">
                  {canManage && editEmail === u.email ? (
                    <select
                      value={editCap}
                      disabled={busy}
                      onChange={(e) => setEditCap(e.target.value as Capability)}
                      className="border border-slate-300 rounded px-2 py-0.5 text-xs bg-white text-slate-900 disabled:opacity-50 dark:bg-slate-800 dark:border-slate-700 dark:text-slate-100"
                    >
                      <option value="read_only">read-only</option>
                      <option value="edit">edit</option>
                    </select>
                  ) : (
                    <CapabilityPill capability={u.capability} />
                  )}
                </td>
                {canManage && (
                  <td className="p-2 text-right whitespace-nowrap space-x-3">
                    {editEmail === u.email ? (
                      <>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() =>
                            setCap.mutate(
                              { email: u.email, capability: editCap },
                              { onSuccess: () => setEditEmail(null) },
                            )
                          }
                          className="text-emerald-700 hover:underline disabled:opacity-40 disabled:no-underline dark:text-emerald-400"
                        >
                          Save
                        </button>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => setEditEmail(null)}
                          className="text-slate-500 hover:underline disabled:opacity-40 disabled:no-underline dark:text-slate-400"
                        >
                          Cancel
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => {
                            setEditEmail(u.email);
                            setEditCap(u.capability);
                          }}
                          className="text-slate-700 hover:underline disabled:opacity-40 disabled:no-underline dark:text-slate-200"
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => setToRemove(u.email)}
                          className="text-red-600 hover:underline disabled:opacity-40 disabled:no-underline dark:text-red-400"
                        >
                          Remove
                        </button>
                      </>
                    )}
                  </td>
                )}
              </tr>
            ))}
            {admins.data && items.length === 0 && (
              <tr>
                <td colSpan={canManage ? 3 : 2} className="p-4 text-center text-slate-500 dark:text-slate-400">
                  No admins assigned. Super admins manage every newsletter.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <ConfirmDialog
        open={toRemove !== null}
        title="Remove admin?"
        message={<>Remove <span className="font-medium">{toRemove}</span> from this newsletter?</>}
        confirmLabel="Remove"
        danger
        busy={remove.isPending}
        onCancel={() => setToRemove(null)}
        onConfirm={() => {
          if (toRemove) remove.mutate(toRemove, { onSettled: () => setToRemove(null) });
        }}
      />
    </div>
  );
}

function CapabilityPill({ capability }: { capability: Capability }) {
  const cls =
    capability === 'edit'
      ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300'
      : 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300';
  return (
    <span className={`inline-block rounded px-2 py-0.5 text-xs font-medium ${cls}`}>
      {capability === 'edit' ? 'edit' : 'read-only'}
    </span>
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
