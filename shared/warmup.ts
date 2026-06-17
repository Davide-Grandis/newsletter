// Warmup helpers (no I/O) used by the consumer to throttle sending and by the
// admin worker to surface progression. Warmup is always on and cannot be
// disabled.
//
// The per-day sending cap follows a geometric (exponential) progression:
//
//   V(t) = minDaily × (maxDaily / minDaily) ^ ((t − 1) / (totalDays − 1))
//
// With the built-in defaults (minDaily=500, maxDaily=50 000, totalDays=30):
//   V(1)  =  500    (day 1 — minimum)
//   V(15) ≈ 15 811  (mid-ramp)
//   V(30) = 50 000  (day 30 — maximum / steady state)
//
// This is equivalent to the formula given in the spec:
//   V(t) = 500 × 100 ^ ((t − 1) / 29)
//
// Progression is DEMAND-DRIVEN, not calendar-driven:
//   - Warmup starts (day 1) the first time demand > 0.
//   - Advances one day when the UTC calendar date changes AND demand > 0.
//   - If no emails are queued for X calendar days, warmup stays put.
// "Demand" = emails still to send across active campaigns.
// Days never decrease and cap at totalDays (steady-state).

export interface WarmupConfig {
  /** Minimum daily cap (day 1). */
  minDaily: number;
  /** Maximum daily cap (day totalDays, steady state). */
  maxDaily: number;
  /** Total warmup days before reaching maxDaily. */
  totalDays: number;
  /** Daily cap used when the Cloudflare API value is unavailable. */
  fallbackDailyCap: number;
}

/** Persisted warmup progression + cached daily quota (the `warmup_state` row). */
export interface WarmupState {
  /** Current warmup day (1-based), or null until warmup has started. */
  day: number | null;
  /** UTC 'YYYY-MM-DD' the current warmup day began, or null. */
  dayStartedAt: string | null;
  /** Last daily cap read from the Cloudflare API (per-day), or null. */
  dailyCap: number | null;
  /** UTC 'YYYY-MM-DD' the daily cap was read, or null. */
  dailyCapDate: string | null;
}

const DEFAULT_MIN_DAILY = 500;
const DEFAULT_MAX_DAILY = 50000;
const DEFAULT_TOTAL_DAYS = 30;
const DEFAULT_FALLBACK_DAILY_CAP = 1000;

export function readWarmupConfig(env: Record<string, string | undefined>): WarmupConfig {
  return {
    minDaily: posNumOr(env.WARMUP_MIN_DAILY, DEFAULT_MIN_DAILY),
    maxDaily: posNumOr(env.WARMUP_MAX_DAILY, DEFAULT_MAX_DAILY),
    totalDays: posNumOr(env.WARMUP_DAYS, DEFAULT_TOTAL_DAYS),
    fallbackDailyCap: posNumOr(env.DAILY_CAP_FALLBACK, DEFAULT_FALLBACK_DAILY_CAP),
  };
}

function posNumOr(v: string | undefined, fallback: number): number {
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const MS_PER_DAY = 24 * 3600 * 1000;

/**
 * Warmup daily cap for day `t` (1-based). Geometric progression from minDaily
 * to maxDaily over totalDays days. Days beyond totalDays return maxDaily.
 *
 *   V(t) = minDaily × (maxDaily / minDaily) ^ ((t − 1) / (totalDays − 1))
 */
export function dailyCapForDay(day: number | null, cfg: WarmupConfig): number {
  if (day === null || day <= 1) return cfg.minDaily;
  if (day >= cfg.totalDays) return cfg.maxDaily;
  const t = day - 1;
  const n = cfg.totalDays - 1;
  return Math.round(cfg.minDaily * Math.pow(cfg.maxDaily / cfg.minDaily, t / n));
}

/** Normalize the Cloudflare quota (`day`/`hour`) to a per-day figure. */
export function normalizeDailyCap(
  quota: { unit: string; value: number } | null,
  fallback: number,
): number {
  if (!quota || typeof quota.value !== 'number') return fallback;
  if (quota.unit === 'hour') return quota.value * 24;
  return quota.value;
}

export interface Progression {
  day: number | null;
  dayStartedAt: string | null;
  /** True when the caller should persist the new day/dayStartedAt. */
  changed: boolean;
}

/**
 * Demand-driven progression. Decides whether to start or advance the warmup
 * day based on the persisted state, current demand, and the wall clock:
 *   - not started: enter day 1 when demand > 0;
 *   - same UTC calendar date as dayStartedAt: no change;
 *   - new calendar date + demand > 0: advance one day (capped at totalDays);
 *   - new calendar date + demand = 0: stay put (warmup pauses).
 */
export function progressWarmup(
  state: WarmupState,
  demand: number,
  now: Date,
  cfg: WarmupConfig,
): Progression {
  const todayStr = now.toISOString().slice(0, 10); // 'YYYY-MM-DD'
  if (state.day === null) {
    if (demand > 0) {
      return { day: 1, dayStartedAt: todayStr, changed: true };
    }
    return { day: null, dayStartedAt: null, changed: false };
  }
  // Same calendar day — no change.
  if (state.dayStartedAt === todayStr) {
    return { day: state.day, dayStartedAt: state.dayStartedAt, changed: false };
  }
  // New calendar day: advance only if demand > 0 (else warmup pauses).
  if (demand > 0) {
    const nextDay = Math.min(state.day + 1, cfg.totalDays);
    return { day: nextDay, dayStartedAt: todayStr, changed: true };
  }
  return { day: state.day, dayStartedAt: state.dayStartedAt, changed: false };
}

export function toSqliteUtc(ms: number): string {
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
}

/** UTC-midnight 'YYYY-MM-DD HH:MM:SS' for the day containing `now`. */
export function dayStartSql(now: Date): string {
  return toSqliteUtc(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/**
 * Seconds until the next UTC midnight (i.e. when the daily cap resets).
 * Capped at 43 200 (12 h — the Cloudflare Queues maximum).
 */
export function delayUntilNextWindow(now: Date = new Date()): number {
  const nowMs = now.getTime();
  const dayEndMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) + MS_PER_DAY;
  const sec = Math.max(60, Math.ceil((dayEndMs - nowMs) / 1000));
  return Math.min(sec, 43200);
}
