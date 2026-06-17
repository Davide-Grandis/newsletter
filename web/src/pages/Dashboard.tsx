import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api, Overview, Page, Campaign, EmailSendingStats } from '../api';
import { useIdentity } from '../auth';
import { CampaignStatus } from './Campaigns';

export default function Dashboard() {
  const me = useIdentity();
  const isSuper = me.data?.role === 'super_admin';

  const sending = useQuery({
    queryKey: ['email-sending-stats'],
    queryFn: () => api<EmailSendingStats>('/api/email-sending-stats'),
    enabled: isSuper,
    staleTime: 60_000,
  });

  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ['overview'],
    queryFn: () => api<Overview>('/api/stats/overview'),
  });
  const campaigns = useQuery({
    queryKey: ['overview-campaigns'],
    queryFn: () => api<Page<Campaign>>('/api/campaigns?limit=12'),
  });
  const refreshing = isFetching || campaigns.isFetching || sending.isFetching;
  const refresh = () => {
    refetch();
    campaigns.refetch();
    if (isSuper) sending.refetch();
  };

  if (isLoading) return <div className="text-sm text-slate-500 dark:text-slate-400">Loading…</div>;
  if (error) return <div className="text-sm text-red-600">{(error as Error).message}</div>;
  if (!data) return null;

  const subTotals = Object.fromEntries(data.subscribers.map((s) => [s.status, s.n]));
  const evt = Object.fromEntries(data.events_last_7d.map((e) => [e.type, e.n]));
  const nls = data.newsletters ?? [];
  const enabledCount = nls.filter((n) => n.enabled === 1).length;
  const totalSubs = data.subscribers.reduce((a, s) => a + s.n, 0);
  const recentCampaigns = campaigns.data?.items ?? [];
  // With many newsletters the overview shows only the most active ones; the
  // full list lives on the Newsletters page.
  const TOP_N = 12;
  const topNls = [...nls]
    .sort(
      (a, b) =>
        b.active - a.active ||
        b.subscribers - a.subscribers ||
        a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
    )
    .slice(0, TOP_N);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Overview</h1>
        <button
          type="button"
          onClick={refresh}
          disabled={refreshing}
          className="inline-flex items-center gap-1.5 text-sm border border-slate-200 rounded px-3 py-1.5 bg-white hover:bg-slate-50 disabled:opacity-50 dark:bg-slate-900 dark:border-slate-700 dark:hover:bg-slate-800"
        >
          <RefreshIcon spinning={refreshing} />
          Refresh
        </button>
      </div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card label="Newsletters" value={nls.length} sub={`${enabledCount} enabled`} />
        <Card label="Active subscribers" value={subTotals.active ?? 0} sub={`${totalSubs.toLocaleString()} total`} />
        <Card label="Total campaigns" value={data.campaigns?.total ?? 0} sub={`${data.campaigns?.sent ?? 0} sent`} />
        <Card label="Unsubscribed / bounced" value={(subTotals.unsubscribed ?? 0) + (subTotals.bounced ?? 0)} sub={`${subTotals.bounced ?? 0} bounced`} />
      </div>

      <h2 className="text-base font-medium">Events in the last 7 days</h2>
      <div className="grid grid-cols-2 md:grid-cols-6 gap-4">
        <Card label="Opens" value={evt.open ?? 0} />
        <Card label="Clicks" value={evt.click ?? 0} />
        <Card label="Bounces" value={evt.bounce ?? 0} />
        <Card label="New subs" value={evt.subscribe ?? 0} />
        <Card label="Unsubs" value={evt.unsubscribe ?? 0} />
        <Card label="Downloads" value={evt.download ?? 0} />
      </div>

      {isSuper && (
        <>
          <h2 className="text-base font-medium">Status / warm-up</h2>
          {sending.isLoading ? (
            <div className="text-sm text-slate-500 dark:text-slate-400">Loading…</div>
          ) : sending.error ? (
            <div className="text-sm text-red-600">{(sending.error as Error).message}</div>
          ) : sending.data ? (
            <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
              <Card
                label="Warm-up daily cap"
                value={sending.data.warmup.warmupDailyCap}
                sub={!sending.data.warmup.started ? 'not started' : undefined}
              />
              <Card
                label="Warm-up day"
                value={`${sending.data.warmup.day ?? 0} / ${sending.data.warmup.totalDays}`}
                sub={!sending.data.warmup.started ? 'not started' : undefined}
              />
              <Card
                label="Email daily quota"
                value={sending.data.quota?.value ?? 0}
                sub={!sending.data.quota ? (sending.data.quota_error ? 'unavailable' : 'not assigned') : undefined}
              />
              <Card label="Sent today" value={sending.data.today} />
              <Card label="Backlog" value={sending.data.warmup.demand} />
            </div>
          ) : null}
        </>
      )}

      <section>
        <div className="flex items-baseline justify-between mb-2">
          <h2 className="text-base font-medium">
            By newsletter
            {nls.length > TOP_N && (
              <span className="ml-2 text-xs font-normal text-slate-400 dark:text-slate-500">
                top {TOP_N} by active subscribers
              </span>
            )}
          </h2>
          {nls.length > 0 && (
            <Link to="/newsletters" className="text-sm text-orange-600 hover:underline dark:text-orange-400">
              View all {nls.length} →
            </Link>
          )}
        </div>
        {nls.length === 0 ? (
          <div className="text-sm text-slate-500 dark:text-slate-400">No newsletters yet.</div>
        ) : (
          <div className="bg-white border border-slate-200 rounded overflow-hidden dark:bg-slate-900 dark:border-slate-800">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-slate-600 dark:bg-slate-800/60 dark:text-slate-300">
                <tr>
                  <th className="text-left p-2">Newsletter</th>
                  <th className="text-left p-2">Status</th>
                  <th className="text-right p-2">Active</th>
                  <th className="text-right p-2">Subscribers</th>
                  <th className="text-right p-2">Campaigns</th>
                </tr>
              </thead>
              <tbody>
                {topNls.map((n) => (
                  <tr key={n.id} className="border-t border-slate-100 dark:border-slate-800">
                    <td className="p-2">
                      <Link to={`/newsletters/${n.id}`} className="text-orange-600 hover:underline dark:text-orange-400">
                        {n.name}
                      </Link>
                    </td>
                    <td className="p-2">
                      <span
                        className={`inline-flex items-center gap-1.5 text-xs ${
                          n.enabled ? 'text-emerald-600 dark:text-emerald-400' : 'text-slate-400 dark:text-slate-500'
                        }`}
                      >
                        <span className={`h-1.5 w-1.5 rounded-full ${n.enabled ? 'bg-emerald-500' : 'bg-slate-400'}`} />
                        {n.enabled ? 'Enabled' : 'Disabled'}
                      </span>
                    </td>
                    <td className="p-2 text-right tabular-nums">{n.active.toLocaleString()}</td>
                    <td className="p-2 text-right tabular-nums">{n.subscribers.toLocaleString()}</td>
                    <td className="p-2 text-right tabular-nums">{n.campaigns.toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section>
        <div className="flex items-baseline justify-between mb-2">
          <h2 className="text-base font-medium">Recent campaigns</h2>
          {(data.campaigns?.total ?? 0) > 0 && (
            <Link to="/campaigns" className="text-sm text-orange-600 hover:underline dark:text-orange-400">
              View all {data.campaigns?.total ?? 0} →
            </Link>
          )}
        </div>
        {recentCampaigns.length === 0 ? (
          <div className="text-sm text-slate-500 dark:text-slate-400">No campaigns yet.</div>
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
                </tr>
              </thead>
              <tbody>
                {recentCampaigns.map((c) => (
                  <tr key={c.id} className="border-t border-slate-100 dark:border-slate-800">
                    <td className="p-2">
                      <Link to={`/campaigns/${c.id}`} className="text-orange-600 hover:underline dark:text-orange-400">
                        {c.subject || '(no subject)'}
                      </Link>
                    </td>
                    <td className="p-2 text-slate-500 dark:text-slate-400">{c.newsletter_name ?? '—'}</td>
                    <td className="p-2"><CampaignStatus status={c.status} /></td>
                    <td className="p-2 text-right tabular-nums">{c.total_recipients.toLocaleString()}</td>
                    <td className="p-2 text-right tabular-nums text-emerald-700 dark:text-emerald-400">{c.sent_count.toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

    </div>
  );
}

export function RefreshIcon({ spinning }: { spinning?: boolean }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={spinning ? 'animate-spin' : ''}
      aria-hidden
    >
      <path d="M21 12a9 9 0 1 1-2.64-6.36" />
      <path d="M21 3v6h-6" />
    </svg>
  );
}

function Card({ label, value, sub }: { label: string; value: number | string; sub?: string }) {
  return (
    <div className="bg-white rounded-lg shadow-sm border border-slate-200 p-4 dark:bg-slate-900 dark:border-slate-800">
      <div className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">{label}</div>
      <div className="text-2xl font-semibold mt-1">{typeof value === 'number' ? value.toLocaleString() : value}</div>
      {sub && <div className="text-xs text-slate-400 mt-0.5 dark:text-slate-500">{sub}</div>}
    </div>
  );
}

