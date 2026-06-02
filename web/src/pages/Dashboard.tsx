import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api, Overview, Quota, Page, Campaign } from '../api';
import { CampaignStatus } from './Campaigns';

export default function Dashboard() {
  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ['overview'],
    queryFn: () => api<Overview>('/api/stats/overview'),
  });
  const quota = useQuery({
    queryKey: ['quota'],
    queryFn: () => api<Quota>('/api/quota'),
    refetchInterval: 60_000,
  });
  const campaigns = useQuery({
    queryKey: ['overview-campaigns'],
    queryFn: () => api<Page<Campaign>>('/api/campaigns?limit=12'),
  });
  const refreshing = isFetching || quota.isFetching || campaigns.isFetching;
  const refresh = () => {
    refetch();
    quota.refetch();
    campaigns.refetch();
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

      {quota.data?.enabled && <QuotaPanel q={quota.data} />}

      <h2 className="text-base font-medium">Last 7 days</h2>
      <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
        <Card label="Opens" value={evt.open ?? 0} />
        <Card label="Clicks" value={evt.click ?? 0} />
        <Card label="Bounces" value={evt.bounce ?? 0} />
        <Card label="Unsubs" value={evt.unsubscribe ?? 0} />
        <Card label="Downloads" value={evt.download ?? 0} />
      </div>

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

function QuotaPanel({ q }: { q: Quota }) {
  if (!q.enabled) {
    return (
      <div className="bg-white rounded-lg border border-slate-200 p-4 text-sm text-slate-600 dark:bg-slate-900 dark:border-slate-800 dark:text-slate-300">
        <span className="font-medium text-slate-900 dark:text-slate-100">Warmup</span> disabled — set{' '}
        <code className="bg-slate-100 px-1 rounded text-xs dark:bg-slate-800">WARMUP_START_DATE</code> on
        the consumer worker to enable daily/weekly send caps. Steady-state target:{' '}
        <strong>{q.target.toLocaleString()}/week</strong>.
      </div>
    );
  }
  return (
    <section>
      <h2 className="text-base font-medium mb-2">
        Warmup quota{' '}
        <span className="ml-1 text-xs text-slate-500 font-normal dark:text-slate-400">
          (week {q.weekIndex})
        </span>
      </h2>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <QuotaBar
          label="Today"
          used={q.dailyUsed}
          cap={q.dailyCap}
          subtitle={`${q.dailyRemaining.toLocaleString()} remaining`}
        />
        <QuotaBar
          label="This week"
          used={q.weeklyUsed}
          cap={q.weeklyCap}
          subtitle={`${q.weeklyRemaining.toLocaleString()} remaining · target ${q.target.toLocaleString()}`}
        />
      </div>
    </section>
  );
}

function QuotaBar({ label, used, cap, subtitle }: { label: string; used: number; cap: number; subtitle: string }) {
  const pct = cap > 0 ? Math.min(100, Math.round((used / cap) * 100)) : 0;
  const tone = pct >= 100 ? 'bg-red-500' : pct >= 80 ? 'bg-amber-500' : 'bg-emerald-500';
  return (
    <div className="bg-white rounded-lg border border-slate-200 p-4 dark:bg-slate-900 dark:border-slate-800">
      <div className="flex items-baseline justify-between">
        <span className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">{label}</span>
        <span className="text-sm font-medium">
          {used.toLocaleString()} / {cap.toLocaleString()}
        </span>
      </div>
      <div className="h-2 bg-slate-100 rounded mt-2 overflow-hidden dark:bg-slate-800">
        <div className={`h-full ${tone}`} style={{ width: `${pct}%` }} />
      </div>
      <div className="text-xs text-slate-500 mt-1 dark:text-slate-400">{subtitle}</div>
    </div>
  );
}

function RefreshIcon({ spinning }: { spinning?: boolean }) {
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

function Card({ label, value, sub }: { label: string; value: number; sub?: string }) {
  return (
    <div className="bg-white rounded-lg shadow-sm border border-slate-200 p-4 dark:bg-slate-900 dark:border-slate-800">
      <div className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">{label}</div>
      <div className="text-2xl font-semibold mt-1">{value.toLocaleString()}</div>
      {sub && <div className="text-xs text-slate-400 mt-0.5 dark:text-slate-500">{sub}</div>}
    </div>
  );
}
