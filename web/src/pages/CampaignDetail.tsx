import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { api, CampaignDetail as Detail, Page, Send, TimeseriesRow } from '../api';
import { StatusPill } from './Subscribers';
import { useState } from 'react';

export default function CampaignDetail() {
  const { id = '' } = useParams();
  const detail = useQuery({
    queryKey: ['campaign', id],
    queryFn: () => api<Detail>(`/api/campaigns/${id}`),
  });
  const ts = useQuery({
    queryKey: ['campaign-ts', id],
    queryFn: () => api<{ items: TimeseriesRow[] }>(`/api/campaigns/${id}/timeseries?bucket=hour`),
  });

  const evt = Object.fromEntries((detail.data?.events ?? []).map((e) => [e.type, e.n]));
  const chartData = pivotTimeseries(ts.data?.items ?? []);

  return (
    <div className="space-y-6">
      <div>
        <Link to="/campaigns" className="text-sm text-slate-500 hover:underline dark:text-slate-400">← Campaigns</Link>
        <h1 className="text-xl font-semibold mt-1">{detail.data?.campaign.subject ?? ''}</h1>
        <div className="text-xs text-slate-500 dark:text-slate-400">
          {detail.data?.campaign.newsletter_name && (
            <span className="mr-2">{detail.data.campaign.newsletter_name}</span>
          )}
          <span className="font-mono">{id}</span>
        </div>
      </div>

      {detail.data && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-6 gap-3">
            <Stat label="Status" value={detail.data.campaign.status} />
            <Stat label="Recipients" value={detail.data.campaign.total_recipients} />
            <Stat label="Sent" value={detail.data.campaign.sent_count} ok />
            <Stat label="Failed" value={detail.data.campaign.failed_count} bad />
            <Stat label="Opens" value={evt.open ?? 0} />
            <Stat label="Clicks" value={evt.click ?? 0} />
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Stat label="Bounces" value={evt.bounce ?? 0} />
            <Stat label="Unsubs" value={evt.unsubscribe ?? 0} />
            <Stat label="Downloads" value={evt.download ?? 0} />
            <Stat label="Attachments" value={detail.data.campaign.attachment_count} />
          </div>
        </>
      )}

      <section>
        <h2 className="text-base font-medium mb-2">Events over time</h2>
        <div className="h-72 bg-white border border-slate-200 rounded p-2 dark:bg-slate-900 dark:border-slate-800">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" className="stroke-slate-200 dark:stroke-slate-700" />
              <XAxis dataKey="bucket" fontSize={10} />
              <YAxis fontSize={10} />
              <Tooltip />
              <Legend />
              <Bar dataKey="open" stackId="a" fill="#10b981" />
              <Bar dataKey="click" stackId="a" fill="#3b82f6" />
              <Bar dataKey="bounce" stackId="a" fill="#f59e0b" />
              <Bar dataKey="unsubscribe" stackId="a" fill="#94a3b8" />
              <Bar dataKey="download" stackId="a" fill="#8b5cf6" />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </section>

      {detail.data && detail.data.attachments.length > 0 && (
        <section>
          <h2 className="text-base font-medium mb-2">Attachments</h2>
          <ul className="bg-white border border-slate-200 rounded divide-y divide-slate-100 text-sm dark:bg-slate-900 dark:border-slate-800 dark:divide-slate-800">
            {detail.data.attachments.map((a) => (
              <li key={a.id} className="p-2 flex justify-between">
                <span>{a.filename} <span className="text-xs text-slate-500 dark:text-slate-400">({a.disposition})</span></span>
                <span className="text-xs text-slate-500 dark:text-slate-400">{a.content_type} · {(a.size / 1024).toFixed(1)} KB</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <SendsTable campaignId={id} />
    </div>
  );
}

function Stat({ label, value, ok, bad }: { label: string; value: string | number; ok?: boolean; bad?: boolean }) {
  const cls = ok ? 'text-emerald-700 dark:text-emerald-400' : bad ? 'text-red-700 dark:text-red-400' : 'text-slate-900 dark:text-slate-100';
  return (
    <div className="bg-white rounded border border-slate-200 p-3 dark:bg-slate-900 dark:border-slate-800">
      <div className="text-[10px] uppercase tracking-wide text-slate-500 dark:text-slate-400">{label}</div>
      <div className={`text-lg font-semibold mt-0.5 ${cls}`}>
        {typeof value === 'number' ? value.toLocaleString() : value}
      </div>
    </div>
  );
}

function pivotTimeseries(rows: TimeseriesRow[]): Record<string, number | string>[] {
  const buckets = new Map<string, Record<string, number | string>>();
  for (const r of rows) {
    const b = buckets.get(r.bucket) ?? { bucket: r.bucket };
    (b as Record<string, number | string>)[r.type] = r.n;
    buckets.set(r.bucket, b);
  }
  return Array.from(buckets.values());
}

function SendsTable({ campaignId }: { campaignId: string }) {
  const [status, setStatus] = useState('failed');
  const [cursor, setCursor] = useState(0);
  const sends = useQuery({
    queryKey: ['campaign-sends', campaignId, status, cursor],
    queryFn: () => {
      const sp = new URLSearchParams({ limit: '50', cursor: String(cursor) });
      if (status) sp.set('status', status);
      return api<Page<Send>>(`/api/campaigns/${campaignId}/sends?${sp.toString()}`);
    },
  });
  return (
    <section>
      <div className="flex items-center gap-2 mb-2">
        <h2 className="text-base font-medium">Sends</h2>
        <select
          value={status}
          onChange={(e) => { setStatus(e.target.value); setCursor(0); }}
          className="border border-slate-300 rounded px-2 py-1 text-xs ml-auto bg-white text-slate-900 dark:bg-slate-800 dark:border-slate-700 dark:text-slate-100"
        >
          <option value="">All</option>
          <option value="sent">Sent</option>
          <option value="failed">Failed</option>
          <option value="queued">Queued</option>
        </select>
      </div>
      <div className="bg-white border border-slate-200 rounded overflow-hidden dark:bg-slate-900 dark:border-slate-800">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-slate-600 dark:bg-slate-800/60 dark:text-slate-300">
            <tr>
              <th className="text-left p-2">Email</th>
              <th className="text-left p-2">Status</th>
              <th className="text-left p-2">Sent at</th>
              <th className="text-left p-2">Error</th>
            </tr>
          </thead>
          <tbody>
            {sends.data?.items.map((s) => (
              <tr key={s.id} className="border-t border-slate-100 dark:border-slate-800">
                <td className="p-2 font-mono text-xs">{s.email ?? `#${s.subscriber_id}`}</td>
                <td className="p-2"><StatusPill status={s.status} /></td>
                <td className="p-2 text-slate-500 dark:text-slate-400">{s.sent_at ?? '—'}</td>
                <td className="p-2 text-red-700 text-xs dark:text-red-400">{s.error ?? ''}</td>
              </tr>
            ))}
            {sends.data && sends.data.items.length === 0 && (
              <tr><td colSpan={4} className="p-4 text-center text-slate-500 dark:text-slate-400">No matching sends.</td></tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="flex justify-end gap-2 text-sm mt-2">
        <button onClick={() => setCursor(0)} disabled={cursor === 0} className="border border-slate-200 rounded px-3 py-1 disabled:opacity-40 dark:border-slate-700">First</button>
        <button
          onClick={() => sends.data?.nextCursor && setCursor(Number(sends.data.nextCursor))}
          disabled={!sends.data?.nextCursor}
          className="border border-slate-200 rounded px-3 py-1 disabled:opacity-40 dark:border-slate-700"
        >Next →</button>
      </div>
    </section>
  );
}
