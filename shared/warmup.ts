// Warmup schedule: pure helpers (no I/O) used by the consumer to throttle
// sending and by the admin worker to surface progression. Warmup is always on
// and cannot be disabled.
//
// Two caps gate every send, the smaller one binds:
//   - weekly cap: a step schedule of weekly ceilings, e.g.
//     [500, 1500, 5000, 12000, 25000, 40000]; steady state is the last
//     step. The active step is the warmup `level`.
//   - daily cap: read fresh from the Cloudflare Email Sending API once per UTC
//     day (the account's resolved daily quota), cached in `warmup_state`.
//
// Progression is DEMAND-DRIVEN, not calendar-driven (there is no start date):
//   - Warmup "starts" (level 0) the first time demand exceeds 499.
//   - Each 7-day window it may advance AT MOST one level, and only when demand
//     has grown to the next level's threshold (= that level's weekly cap).
//     Otherwise it stays put. Levels never decrease.
// "Demand" is the count of emails still to send across active campaigns,
// supplied by the caller. Day/week windows use UTC, matching D1's
// `sent_at = datetime('now')`.

export interface WarmupConfig {
  /** Steady-state weekly cap once the schedule is exhausted. */
  targetWeekly: number;
  /** Per-level weekly caps; index = warmup level. Never empty. */
  schedule: number[];
  /** Daily cap used when the Cloudflare API value is unavailable. */
  fallbackDailyCap: number;
}

/** Persisted warmup progression + cached daily quota (the `warmup_state` row). */
export interface WarmupState {
  /** Current warmup level (0-based), or null until warmup has started. */
  level: number | null;
  /** UTC 'YYYY-MM-DD HH:MM:SS' start of the current weekly window, or null. */
  weekStartedAt: string | null;
  /** Last daily cap read from the API (normalized per-day), or null. */
  dailyCap: number | null;
  /** UTC 'YYYY-MM-DD' the daily cap was read, or null. */
  dailyCapDate: string | null;
}

const DEFAULT_SCHEDULE = [500, 1500, 5000, 12000, 25000, 40000];
const DEFAULT_FALLBACK_DAILY_CAP = 1000;

/** Demand below which warmup has not started yet (level 0 threshold is 500). */
export const WARMUP_START_THRESHOLD = 499;

export function readWarmupConfig(env: Record<string, string | undefined>): WarmupConfig {
  let schedule: number[] | null = null;
  const raw = env.WARMUP_SCHEDULE?.trim();
  if (raw) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0 && parsed.every((n) => typeof n === 'number' && n >= 0)) {
        schedule = parsed as number[];
      }
    } catch {
      // fall through to default
    }
  }
  if (!schedule) schedule = DEFAULT_SCHEDULE.slice();
  return {
    targetWeekly: schedule[schedule.length - 1]!,
    schedule,
    fallbackDailyCap: numOr(env.DAILY_CAP_FALLBACK, DEFAULT_FALLBACK_DAILY_CAP),
  };
}

function numOr(v: string | undefined, fallback: number): number {
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

const MS_PER_DAY = 24 * 3600 * 1000;
const MS_PER_WEEK = 7 * MS_PER_DAY;

/** Highest meaningful level: the first index whose weekly cap is steady state. */
export function maxLevel(cfg: WarmupConfig): number {
  return cfg.schedule.length;
}

/**
 * Weekly cap for a level. Level `null` (warmup not started) uses the first
 * step so small volumes can still flow; levels past the schedule use the
 * steady-state target.
 */
export function weeklyCapForLevel(cfg: WarmupConfig, level: number | null): number {
  const l = level ?? 0;
  if (l < 0) return cfg.schedule[0]!;
  if (l < cfg.schedule.length) return cfg.schedule[l]!;
  return cfg.targetWeekly;
}

/** Demand threshold required to be at a level (= that level's weekly cap). */
export function thresholdForLevel(cfg: WarmupConfig, level: number): number {
  return weeklyCapForLevel(cfg, level);
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
  level: number | null;
  weekStartedAt: string | null;
  /** True when the caller should persist the new level/window. */
  changed: boolean;
}

/**
 * Demand-driven progression. Given the persisted state, current demand (emails
 * still to send) and the wall clock, decide the level + weekly window for now:
 *   - not started: enter level 0 once demand exceeds the start threshold;
 *   - within the current 7-day window: no change;
 *   - window elapsed: open a new window and advance one level iff demand has
 *     reached the next level's threshold (else stay). Levels never decrease.
 */
export function progressWarmup(
  state: WarmupState,
  demand: number,
  now: Date,
  cfg: WarmupConfig,
): Progression {
  if (state.level === null || state.weekStartedAt === null) {
    if (demand > WARMUP_START_THRESHOLD) {
      return { level: 0, weekStartedAt: toSqliteUtc(now.getTime()), changed: true };
    }
    return { level: state.level, weekStartedAt: state.weekStartedAt, changed: false };
  }
  const startedMs = parseSqliteUtc(state.weekStartedAt);
  if (startedMs === null || now.getTime() - startedMs < MS_PER_WEEK) {
    return { level: state.level, weekStartedAt: state.weekStartedAt, changed: false };
  }
  // The weekly window has elapsed: open a fresh one and consider one step up.
  const candidate = Math.min(state.level + 1, maxLevel(cfg));
  let level = state.level;
  if (candidate > state.level && demand >= thresholdForLevel(cfg, candidate)) {
    level = candidate;
  }
  return { level, weekStartedAt: toSqliteUtc(now.getTime()), changed: true };
}

export function toSqliteUtc(ms: number): string {
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
}

function parseSqliteUtc(s: string): number | null {
  // Stored as 'YYYY-MM-DD HH:MM:SS' UTC.
  const ms = Date.parse(s.replace(' ', 'T') + 'Z');
  return Number.isFinite(ms) ? ms : null;
}

/** UTC-midnight 'YYYY-MM-DD HH:MM:SS' for the day containing `now`. */
export function dayStartSql(now: Date): string {
  return toSqliteUtc(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/**
 * How many seconds to wait before re-trying when caps are exhausted. If the
 * weekly cap is exhausted we wait until the weekly window rolls; otherwise
 * until the next UTC day. Cloudflare Queues caps `delaySeconds` at 12h (43200);
 * the caller re-evaluates on the next attempt.
 */
export function delayUntilNextWindow(
  weekStartedAtMs: number,
  weeklyRemaining: number,
  now: Date = new Date(),
): number {
  const nowMs = now.getTime();
  const dayEndMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) + MS_PER_DAY;
  const weekEndMs = weekStartedAtMs + MS_PER_WEEK;
  const target = weeklyRemaining <= 0 ? weekEndMs : dayEndMs;
  const sec = Math.max(60, Math.ceil((target - nowMs) / 1000));
  return Math.min(sec, 43200);
}
