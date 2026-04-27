// Warmup schedule: pure helpers (no I/O) used by the consumer to throttle
// sending and by the admin worker to surface remaining quota.
//
// Caps work in two dimensions:
//   - weekly cap: indexed by the warmup-week, derived from a step schedule
//     (e.g. 500, 1500, 5000, 12000, 25000, 40000, then 50000 steady state)
//     or from the formula `min(target, 500 * 2.5^week)` if no schedule is
//     configured.
//   - daily cap: a flat per-UTC-day ceiling that prevents bursting through
//     the weekly cap in a single day. 5K/day for weeks 0-4 by default; 10K/day
//     from week `lateStartWeek` (5) onwards.
//
// "Week" is measured from `WARMUP_START_DATE` (UTC midnight). Day windows are
// calendar UTC days, which matches `sent_at = datetime('now')` in D1.

export interface WarmupConfig {
  /** ISO date 'YYYY-MM-DD' of week 0; null disables the warmup entirely. */
  startDate: string | null;
  /** Steady-state weekly cap once the schedule is exhausted. */
  targetWeekly: number;
  /** Per-week explicit caps. Index = warmup week. */
  schedule: number[] | null;
  dailyCapEarly: number;
  dailyCapLate: number;
  /** First week (0-based) using the late daily cap. */
  lateStartWeek: number;
}

const DEFAULT_SCHEDULE = [500, 1500, 5000, 12000, 25000, 40000];

export function readWarmupConfig(env: Record<string, string | undefined>): WarmupConfig {
  const target = numOr(env.WARMUP_TARGET_WEEKLY, 50000);
  let schedule: number[] | null = null;
  const raw = env.WARMUP_SCHEDULE?.trim();
  if (raw) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.every((n) => typeof n === 'number' && n >= 0)) {
        schedule = parsed as number[];
      }
    } catch {
      // fall through to default
    }
  }
  if (!schedule) schedule = DEFAULT_SCHEDULE.slice();
  return {
    startDate: env.WARMUP_START_DATE?.trim() || null,
    targetWeekly: target,
    schedule,
    dailyCapEarly: numOr(env.WARMUP_DAILY_CAP_EARLY, 5000),
    dailyCapLate: numOr(env.WARMUP_DAILY_CAP_LATE, 10000),
    lateStartWeek: numOr(env.WARMUP_LATE_START_WEEK, 5),
  };
}

function numOr(v: string | undefined, fallback: number): number {
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function parseStartDate(s: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return Number.isFinite(d.getTime()) ? d : null;
}

const MS_PER_DAY = 24 * 3600 * 1000;
const MS_PER_WEEK = 7 * MS_PER_DAY;

/**
 * Returns the warmup week index (0-based) for `now`, or `null` if no warmup
 * is configured. Negative values mean `now` is before `startDate`.
 */
export function weekIndex(cfg: WarmupConfig, now: Date): number | null {
  if (!cfg.startDate) return null;
  const start = parseStartDate(cfg.startDate);
  if (!start) return null;
  return Math.floor((now.getTime() - start.getTime()) / MS_PER_WEEK);
}

export function weeklyCapFor(cfg: WarmupConfig, week: number): number {
  if (week < 0) return 0;
  const sched = cfg.schedule ?? [];
  if (sched.length > 0) {
    if (week < sched.length) return sched[week]!;
    return cfg.targetWeekly;
  }
  // Formula fallback if WARMUP_SCHEDULE was set to '[]'.
  return Math.min(cfg.targetWeekly, Math.floor(500 * Math.pow(2.5, week)));
}

export function dailyCapFor(cfg: WarmupConfig, week: number): number {
  if (week < 0) return 0;
  return week < cfg.lateStartWeek ? cfg.dailyCapEarly : cfg.dailyCapLate;
}

export interface CurrentWindow {
  weekIndex: number;
  dailyCap: number;
  weeklyCap: number;
  /** SQLite-comparable 'YYYY-MM-DD HH:MM:SS' UTC strings for `sent_at` filters. */
  dayStartSql: string;
  weekStartSql: string;
  /** Epoch ms for delay calculation. */
  dayEndMs: number;
  weekEndMs: number;
}

/**
 * Computes the current daily and weekly windows. Returns `null` when warmup
 * is disabled (i.e. `WARMUP_START_DATE` is empty) — callers should treat
 * `null` as "no caps, send freely".
 */
export function currentWindow(cfg: WarmupConfig, now: Date): CurrentWindow | null {
  if (!cfg.startDate) return null;
  const start = parseStartDate(cfg.startDate);
  if (!start) return null;
  const week = Math.max(0, Math.floor((now.getTime() - start.getTime()) / MS_PER_WEEK));
  const weekStartMs = start.getTime() + week * MS_PER_WEEK;
  // Calendar UTC day for the daily window.
  const dayStartMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return {
    weekIndex: week,
    dailyCap: dailyCapFor(cfg, week),
    weeklyCap: weeklyCapFor(cfg, week),
    dayStartSql: toSqliteUtc(dayStartMs),
    weekStartSql: toSqliteUtc(weekStartMs),
    dayEndMs: dayStartMs + MS_PER_DAY,
    weekEndMs: weekStartMs + MS_PER_WEEK,
  };
}

function toSqliteUtc(ms: number): string {
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
}

/**
 * How many seconds to wait before re-trying when caps are exhausted.
 * Caller passes remaining capacity so we can pick the right boundary
 * (next-day if only daily is exhausted, next-week if weekly is too).
 *
 * Cloudflare Queues caps `delaySeconds` at 12h (43200); if the next window is
 * further away the caller will simply retry after 12h and re-evaluate.
 */
export function delayUntilNextWindow(
  win: CurrentWindow,
  dailyRemaining: number,
  weeklyRemaining: number,
  nowMs: number = Date.now(),
): number {
  const target = weeklyRemaining <= 0 ? win.weekEndMs : win.dayEndMs;
  const sec = Math.max(60, Math.ceil((target - nowMs) / 1000));
  void dailyRemaining;
  return Math.min(sec, 43200);
}
