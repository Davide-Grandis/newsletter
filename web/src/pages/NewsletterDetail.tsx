import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, Newsletter } from '../api';
import Subscribers from './Subscribers';
import Authors from './Authors';

type Tab = 'subscribers' | 'authors';

export default function NewsletterDetail() {
  const { id = '' } = useParams();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [tab, setTab] = useState<Tab>('subscribers');
  const [warn, setWarn] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [delErr, setDelErr] = useState<string | null>(null);

  const detail = useQuery({
    queryKey: ['newsletter', id],
    queryFn: () => api<Newsletter>(`/api/newsletters/${id}`),
  });

  const patch = useMutation({
    mutationFn: (body: Partial<Pick<Newsletter, 'name' | 'inbound_address' | 'from_address'>> & { enabled?: boolean }) =>
      api<{ routing_warning?: string }>(`/api/newsletters/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
    onSuccess: (res) => {
      setWarn(res.routing_warning ?? null);
      qc.invalidateQueries({ queryKey: ['newsletter', id] });
      qc.invalidateQueries({ queryKey: ['newsletters'] });
    },
  });

  const del = useMutation({
    mutationFn: () => api(`/api/newsletters/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['newsletters'] });
      navigate('/newsletters');
    },
    onError: (e) => setDelErr((e as Error).message),
  });

  if (detail.isLoading) return <div className="text-sm text-slate-500 dark:text-slate-400">Loading…</div>;
  if (detail.error) return <div className="text-sm text-red-600">{(detail.error as Error).message}</div>;
  if (!detail.data) return null;
  const n = detail.data;

  return (
    <div className="space-y-6">
      <div>
        <Link to="/newsletters" className="text-sm text-slate-500 hover:underline dark:text-slate-400">← Newsletters</Link>
        <h1 className="text-xl font-semibold mt-1">{n.name}</h1>
      </div>

      {warn && (
        <div className="flex items-start gap-2 text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded p-2 dark:text-amber-300 dark:bg-amber-900/30 dark:border-amber-800/60">
          <span className="flex-1">{warn}</span>
          <button onClick={() => setWarn(null)} className="text-amber-600 hover:underline dark:text-amber-400">dismiss</button>
        </div>
      )}

      <Settings
        n={n}
        onSave={(body) => patch.mutate(body)}
        saving={patch.isPending}
        onDelete={() => {
          setDelErr(null);
          setConfirmDelete(true);
        }}
      />

      {confirmDelete && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-sm bg-white rounded-lg shadow-lg p-5 dark:bg-slate-900 dark:border dark:border-slate-700">
            <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">Delete newsletter?</h2>
            <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">
              This permanently deletes <span className="font-medium">{n.name}</span>, its subscribers, authors and
              Email Routing rule. This cannot be undone.
            </p>
            {delErr && <p className="mt-2 text-sm text-red-600">{delErr}</p>}
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                disabled={del.isPending}
                onClick={() => setConfirmDelete(false)}
                className="text-sm rounded px-3 py-1.5 border border-slate-200 text-slate-700 hover:bg-slate-50 disabled:opacity-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={del.isPending}
                onClick={() => del.mutate()}
                className="text-sm rounded px-3 py-1.5 bg-red-600 text-white hover:bg-red-700 disabled:opacity-50"
              >
                {del.isPending ? 'Deleting…' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}

      <div>
        <div className="flex gap-1 border-b border-slate-200 dark:border-slate-800 mb-4">
          <TabButton active={tab === 'subscribers'} onClick={() => setTab('subscribers')}>
            Subscribers {typeof n.subscriber_count === 'number' ? `(${n.subscriber_count})` : ''}
          </TabButton>
          <TabButton active={tab === 'authors'} onClick={() => setTab('authors')}>
            Authors {typeof n.author_count === 'number' ? `(${n.author_count})` : ''}
          </TabButton>
        </div>
        {tab === 'subscribers' ? <Subscribers newsletterId={id} /> : <Authors newsletterId={id} />}
      </div>
    </div>
  );
}

function Settings({
  n,
  onSave,
  saving,
  onDelete,
}: {
  n: Newsletter;
  onSave: (body: { name?: string; inbound_address?: string; from_address?: string | null }) => void;
  saving: boolean;
  onDelete: () => void;
}) {
  const [name, setName] = useState(n.name);
  const [addr, setAddr] = useState(n.inbound_address);
  const [from, setFrom] = useState(n.from_address ?? '');
  const dirty =
    name.trim() !== n.name ||
    addr.trim() !== n.inbound_address ||
    from.trim() !== (n.from_address ?? '');

  return (
    <section className="bg-white border border-slate-200 rounded p-3 dark:bg-slate-900 dark:border-slate-800">
      <div className="flex flex-wrap items-end gap-2">
        <div className="flex-1 min-w-[160px]">
          <label className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">Name</label>
          <input value={name} onChange={(e) => setName(e.target.value)} className={inputCls} />
        </div>
        <div className="flex-1 min-w-[220px]">
          <label className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">Inbound address</label>
          <input value={addr} onChange={(e) => setAddr(e.target.value)} type="email" className={inputCls} />
        </div>
        <div className="flex-1 min-w-[220px]">
          <label className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">
            Sender <span className="normal-case tracking-normal text-slate-400">(optional)</span>
          </label>
          <input
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            placeholder="falls back to default sender"
            className={inputCls}
          />
        </div>
        <button
          type="button"
          disabled={!dirty || saving}
          onClick={() =>
            onSave({ name: name.trim(), inbound_address: addr.trim(), from_address: from.trim() })
          }
          className="bg-slate-900 text-white text-sm rounded px-3 py-1.5 disabled:opacity-50 dark:bg-slate-100 dark:text-slate-900"
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button
          type="button"
          onClick={onDelete}
          className="bg-red-600 text-white text-sm rounded px-3 py-1.5 hover:bg-red-700"
        >
          Delete
        </button>
      </div>
      <p className="text-xs text-slate-400 dark:text-slate-500 mt-2">
        Inbound mail to <code className="bg-slate-100 px-1 rounded dark:bg-slate-800">{n.inbound_address}</code> is routed to the ingest worker automatically via an Email Routing rule.
        The <strong>Sender</strong> is the outgoing <code className="bg-slate-100 px-1 rounded dark:bg-slate-800">From:</code> for this newsletter (must be on the sending domain); leave empty to use the global default.
      </p>
    </section>
  );
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`px-3 py-2 text-sm -mb-px border-b-2 ${
        active
          ? 'border-slate-900 text-slate-900 font-medium dark:border-slate-100 dark:text-slate-100'
          : 'border-transparent text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100'
      }`}
    >
      {children}
    </button>
  );
}

const inputCls =
  'block w-full border border-slate-300 rounded px-2 py-1 text-sm mt-0.5 bg-white text-slate-900 dark:bg-slate-800 dark:border-slate-700 dark:text-slate-100';
