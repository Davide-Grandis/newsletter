import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api, BounceEvent } from '../api';

export default function Bounces() {
  const { data, isLoading } = useQuery({
    queryKey: ['bounces'],
    queryFn: () => api<{ items: BounceEvent[] }>('/api/bounces?limit=200'),
  });

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold">Recent bounces (7d)</h1>
      {isLoading ? (
        <div className="text-sm text-slate-500 dark:text-slate-400">Loading…</div>
      ) : (
        <div className="bg-white border border-slate-200 rounded overflow-hidden dark:bg-slate-900 dark:border-slate-800">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-slate-600 dark:bg-slate-800/60 dark:text-slate-300">
              <tr>
                <th className="text-left p-2">When</th>
                <th className="text-left p-2">Email</th>
                <th className="text-left p-2">Status</th>
                <th className="text-left p-2">Campaign</th>
              </tr>
            </thead>
            <tbody>
              {data?.items.map((b) => (
                <tr key={b.id} className="border-t border-slate-100 dark:border-slate-800">
                  <td className="p-2 text-slate-500 dark:text-slate-400">{b.ts}</td>
                  <td className="p-2 font-mono text-xs">{b.email ?? `#${b.subscriber_id}`}</td>
                  <td className="p-2">
                    <span className={`text-xs px-2 py-0.5 rounded ${
                      b.status_code?.startsWith('5') ? 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300' : 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300'
                    }`}>{b.status_code ?? '—'}</span>
                  </td>
                  <td className="p-2">
                    <Link to={`/campaigns/${b.campaign_id}`} className="text-xs text-slate-500 hover:underline font-mono dark:text-slate-400">
                      {b.campaign_id?.slice(0, 8)}…
                    </Link>
                  </td>
                </tr>
              ))}
              {data && data.items.length === 0 && (
                <tr><td colSpan={4} className="p-4 text-center text-slate-500 dark:text-slate-400">No bounces in the last 7 days. </td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
