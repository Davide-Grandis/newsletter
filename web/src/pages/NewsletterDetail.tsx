import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { api, Newsletter } from '../api';
import Subscribers from './Subscribers';
import Authors from './Authors';
import { Toggle } from './Newsletters';

type Tab = 'subscribers' | 'authors';

export default function NewsletterDetail() {
  const { id = '' } = useParams();
  const qc = useQueryClient();
  const [tab, setTab] = useState<Tab>('subscribers');

  const detail = useQuery({
    queryKey: ['newsletter', id],
    queryFn: () => api<Newsletter>(`/api/newsletters/${id}`),
  });

  const patch = useMutation({
    mutationFn: (body: Partial<Pick<Newsletter, 'name' | 'inbound_address'>> & { enabled?: boolean }) =>
      api(`/api/newsletters/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['newsletter', id] });
      qc.invalidateQueries({ queryKey: ['newsletters'] });
    },
  });

  if (detail.isLoading) return <div className="text-sm text-slate-500 dark:text-slate-400">Loading…</div>;
  if (detail.error) return <div className="text-sm text-red-600">{(detail.error as Error).message}</div>;
  if (!detail.data) return null;
  const n = detail.data;

  return (
    <div className="space-y-6">
      <div>
        <Link to="/newsletters" className="text-sm text-slate-500 hover:underline dark:text-slate-400">← Newsletters</Link>
        <div className="flex items-center gap-3 mt-1">
          <h1 className="text-xl font-semibold">{n.name}</h1>
          <span className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
            {n.enabled === 1 ? 'Enabled' : 'Disabled'}
            <Toggle on={n.enabled === 1} busy={patch.isPending} onChange={(enabled) => patch.mutate({ enabled })} />
          </span>
        </div>
      </div>

      <Settings n={n} onSave={(body) => patch.mutate(body)} saving={patch.isPending} />

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
}: {
  n: Newsletter;
  onSave: (body: { name?: string; inbound_address?: string }) => void;
  saving: boolean;
}) {
  const [name, setName] = useState(n.name);
  const [addr, setAddr] = useState(n.inbound_address);
  const dirty = name.trim() !== n.name || addr.trim() !== n.inbound_address;

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
        <button
          type="button"
          disabled={!dirty || saving}
          onClick={() => onSave({ name: name.trim(), inbound_address: addr.trim() })}
          className="bg-slate-900 text-white text-sm rounded px-3 py-1.5 disabled:opacity-50 dark:bg-slate-100 dark:text-slate-900"
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
      <p className="text-xs text-slate-400 dark:text-slate-500 mt-2">
        Add an Email Routing rule pointing <code className="bg-slate-100 px-1 rounded dark:bg-slate-800">{n.inbound_address}</code> at the ingest worker.
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
