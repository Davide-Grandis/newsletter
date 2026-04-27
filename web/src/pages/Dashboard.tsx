import { useQuery } from '@tanstack/react-query';
import { api, Overview, Quota } from '../api';
import { useAuth } from '../auth';

export default function Dashboard() {
  const { token } = useAuth();
  const { data, isLoading, error } = useQuery({
    queryKey: ['overview'],
    queryFn: () => api<Overview>(token!, '/api/stats/overview'),
  });
  const quota = useQuery({
    queryKey: ['quota'],
    queryFn: () => api<Quota>(token!, '/api/quota'),
    refetchInterval: 60_000,
  });

  if (isLoading) return <div className="text-sm text-slate-500">Loading…</div>;
  if (error) return <div className="text-sm text-red-600">{(error as Error).message}</div>;
  if (!data) return null;

  const subTotals = Object.fromEntries(data.subscribers.map((s) => [s.status, s.n]));
  const evt = Object.fromEntries(data.events_last_7d.map((e) => [e.type, e.n]));

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold">Overview</h1>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card label="Active subscribers" value={subTotals.active ?? 0} />
        <Card label="Unsubscribed" value={subTotals.unsubscribed ?? 0} />
        <Card label="Bounced" value={subTotals.bounced ?? 0} />
        <Card label="Total campaigns" value={data.campaigns?.total ?? 0} />
      </div>

      {quota.data && <QuotaPanel q={quota.data} />}

      <h2 className="text-base font-medium">Last 7 days</h2>
      <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
        <Card label="Opens" value={evt.open ?? 0} />
        <Card label="Clicks" value={evt.click ?? 0} />
        <Card label="Bounces" value={evt.bounce ?? 0} />
        <Card label="Unsubs" value={evt.unsubscribe ?? 0} />
        <Card label="Downloads" value={evt.download ?? 0} />
      </div>
    </div>
  );
}

function QuotaPanel({ q }: { q: Quota }) {
  if (!q.enabled) {
    return (
      <div className="bg-white rounded-lg border p-4 text-sm text-slate-600">
        <span className="font-medium text-slate-900">Warmup</span> disabled — set{' '}
        <code className="bg-slate-100 px-1 rounded text-xs">WARMUP_START_DATE</code> on
        the consumer worker to enable daily/weekly send caps. Steady-state target:{' '}
        <strong>{q.target.toLocaleString()}/week</strong>.
      </div>
    );
  }
  return (
    <section>
      <h2 className="text-base font-medium mb-2">
        Warmup quota{' '}
        <span className="ml-1 text-xs text-slate-500 font-normal">
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
    <div className="bg-white rounded-lg border p-4">
      <div className="flex items-baseline justify-between">
        <span className="text-xs uppercase tracking-wide text-slate-500">{label}</span>
        <span className="text-sm font-medium">
          {used.toLocaleString()} / {cap.toLocaleString()}
        </span>
      </div>
      <div className="h-2 bg-slate-100 rounded mt-2 overflow-hidden">
        <div className={`h-full ${tone}`} style={{ width: `${pct}%` }} />
      </div>
      <div className="text-xs text-slate-500 mt-1">{subtitle}</div>
    </div>
  );
}

function Card({ label, value }: { label: string; value: number }) {
  return (
    <div className="bg-white rounded-lg shadow-sm border p-4">
      <div className="text-xs uppercase tracking-wide text-slate-500">{label}</div>
      <div className="text-2xl font-semibold mt-1">{value.toLocaleString()}</div>
    </div>
  );
}
