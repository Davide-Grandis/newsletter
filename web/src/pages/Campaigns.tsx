import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api, Campaign, Page } from '../api';

export default function Campaigns() {
  const { data, isLoading } = useQuery({
    queryKey: ['campaigns'],
    queryFn: () => api<Page<Campaign>>('/api/campaigns?limit=100'),
  });

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold">Campaigns</h1>
      {isLoading ? (
        <div className="text-sm text-slate-500 dark:text-slate-400">Loading…</div>
      ) : (
        <div className="bg-white border border-slate-200 rounded overflow-hidden dark:bg-slate-900 dark:border-slate-800">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-slate-600 dark:bg-slate-800/60 dark:text-slate-300">
              <tr>
                <th className="text-left p-2">Subject</th>
                <th className="text-left p-2">Newsletter</th>
                <th className="text-left p-2">Status</th>
                <th className="text-right p-2">Recipients</th>
                <th className="text-right p-2">Sent</th>
                <th className="text-right p-2">Failed</th>
                <th className="text-right p-2">Att.</th>
                <th className="text-left p-2">Sent at</th>
              </tr>
            </thead>
            <tbody>
              {data?.items.map((c) => (
                <tr key={c.id} className="border-t border-slate-100 hover:bg-slate-50 dark:border-slate-800 dark:hover:bg-slate-800/50">
                  <td className="p-2">
                    <Link to={`/campaigns/${c.id}`} className="text-slate-900 hover:underline dark:text-slate-100">
                      {c.subject || '(no subject)'}
                    </Link>
                    {c.link_mode === 1 && (
                      <span className="ml-2 text-[10px] uppercase tracking-wide bg-amber-100 text-amber-800 px-1 rounded">link mode</span>
                    )}
                  </td>
                  <td className="p-2 text-slate-500 dark:text-slate-400">{c.newsletter_name ?? '—'}</td>
                  <td className="p-2"><CampaignStatus status={c.status} /></td>
                  <td className="p-2 text-right">{c.total_recipients}</td>
                  <td className="p-2 text-right text-emerald-700 dark:text-emerald-400">{c.sent_count}</td>
                  <td className="p-2 text-right text-red-700 dark:text-red-400">{c.failed_count}</td>
                  <td className="p-2 text-right">{c.attachment_count}</td>
                  <td className="p-2 text-slate-500 dark:text-slate-400">{c.created_at}</td>
                </tr>
              ))}
              {data && data.items.length === 0 && (
                <tr><td colSpan={8} className="p-4 text-center text-slate-500 dark:text-slate-400">No campaigns yet.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// Coloured badge for a campaign's lifecycle status. Running campaigns
// (`sending`) get an animated pulse so they stand out at a glance.
export function CampaignStatus({ status }: { status: string }) {
  const cls: Record<string, string> = {
    queued: 'bg-slate-100 text-slate-700 dark:bg-slate-700 dark:text-slate-200',
    sending: 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300',
    done: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300',
    failed: 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300',
  };
  const running = status === 'sending';
  return (
    <span
      className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded ${
        cls[status] ?? 'bg-slate-100 text-slate-700 dark:bg-slate-700 dark:text-slate-200'
      }`}
    >
      {running && <span className="h-1.5 w-1.5 rounded-full bg-blue-500 animate-pulse" />}
      {status}
    </span>
  );
}
