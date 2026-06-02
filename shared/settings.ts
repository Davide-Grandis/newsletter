// Central runtime configuration shared by every worker.
//
// Historically each worker read its tunables straight from `env` (wrangler
// vars). Those values are now overridable at runtime via the D1 `settings`
// table, edited from the admin console's Settings page. Resolution order for
// any key is: D1 `settings` row -> worker env var -> built-in default below.
//
// `wrangler.toml` vars are kept as per-worker fallbacks/documentation; the
// `SETTINGS_DEFAULTS` map is the single source of truth for what a value
// becomes when neither the table nor env provides it.

export const SETTING_KEYS = [
  // -- Deployment & routing (group B) --
  'EMAIL_ROUTING_ZONE_ID',
  'INGEST_WORKER_NAME',
  'BASE_DOMAIN',
  // -- Sending identity --
  'FROM_ADDRESS',
  'BOUNCE_DOMAIN',
  'TRACKING_BASE_URL',
  // -- Attachments --
  'MAX_ATTACHMENT_BYTES',
  'MAX_TOTAL_ATTACHMENT_BYTES',
  'MAX_ATTACHMENT_COUNT',
  'ALLOWED_MIME',
  'BLOCKED_EXTENSIONS',
  'ATTACHMENT_LINK_THRESHOLD_BYTES',
  // -- Batching & size limits --
  'BATCH_SIZE',
  'MAX_RAW_BYTES',
  // -- Retention --
  'RETENTION_DAYS',
  // -- Bounce handling --
  'HARD_BOUNCE_THRESHOLD',
  'SOFT_BOUNCE_THRESHOLD',
  // -- Warmup --
  'WARMUP_START_DATE',
  'WARMUP_TARGET_WEEKLY',
  'WARMUP_SCHEDULE',
  'WARMUP_DAILY_CAP_EARLY',
  'WARMUP_DAILY_CAP_LATE',
  'WARMUP_LATE_START_WEEK',
] as const;

export type SettingKey = (typeof SETTING_KEYS)[number];

const ALLOWED = new Set<string>(SETTING_KEYS);

export function isSettingKey(k: string): k is SettingKey {
  return ALLOWED.has(k);
}

// Built-in defaults. Deployment-specific values (zone id, domains, sending
// identity) intentionally default to '' so they must come from env or the
// settings table; the rest mirror the historical wrangler.toml vars.
export const SETTINGS_DEFAULTS: Record<SettingKey, string> = {
  EMAIL_ROUTING_ZONE_ID: '',
  INGEST_WORKER_NAME: 'newsletter-ingest',
  BASE_DOMAIN: '',
  FROM_ADDRESS: '',
  BOUNCE_DOMAIN: '',
  TRACKING_BASE_URL: '',
  MAX_ATTACHMENT_BYTES: '10485760',
  MAX_TOTAL_ATTACHMENT_BYTES: '20971520',
  MAX_ATTACHMENT_COUNT: '10',
  ALLOWED_MIME: 'image/*,application/pdf,text/plain,text/csv,application/zip',
  BLOCKED_EXTENSIONS: 'exe,js,bat,cmd,scr,com,vbs,ps1',
  ATTACHMENT_LINK_THRESHOLD_BYTES: '8388608',
  BATCH_SIZE: '100',
  MAX_RAW_BYTES: '39000000',
  RETENTION_DAYS: '90',
  HARD_BOUNCE_THRESHOLD: '1',
  SOFT_BOUNCE_THRESHOLD: '5',
  WARMUP_START_DATE: '',
  WARMUP_TARGET_WEEKLY: '50000',
  WARMUP_SCHEDULE: '[500, 1500, 5000, 12000, 25000, 40000]',
  WARMUP_DAILY_CAP_EARLY: '5000',
  WARMUP_DAILY_CAP_LATE: '10000',
  WARMUP_LATE_START_WEEK: '5',
};

/**
 * Reads all overrides from the `settings` table. Returns a plain map of the
 * allow-listed keys that actually have a stored row. Tolerates a missing
 * table (returns an empty map) so workers keep running before the migration
 * is applied.
 */
export async function readStoredSettings(
  db: D1Database,
): Promise<Map<SettingKey, string>> {
  const out = new Map<SettingKey, string>();
  try {
    const { results } = await db
      .prepare('SELECT key, value FROM settings')
      .all<{ key: string; value: string }>();
    for (const row of results ?? []) {
      if (isSettingKey(row.key)) out.set(row.key, row.value);
    }
  } catch {
    // settings table not present yet -> env/defaults only.
  }
  return out;
}

/**
 * Returns a copy of `env` with the configurable keys resolved against the
 * `settings` table (then env, then defaults). Bindings and secrets on `env`
 * are preserved untouched; only allow-listed string keys are overlaid, so the
 * settings table can never inject a value for a binding or secret.
 */
export async function loadSettings<T extends object>(
  db: D1Database,
  env: T,
): Promise<T> {
  const stored = await readStoredSettings(db);
  const src = env as Record<string, unknown>;
  const merged: Record<string, unknown> = { ...src };
  for (const key of SETTING_KEYS) {
    // D1 row -> env var -> built-in default. An env var explicitly set to ''
    // (e.g. WARMUP_START_DATE meaning "disabled") is preserved, not replaced.
    const fromEnv = src[key] as string | undefined;
    merged[key] = stored.get(key) ?? fromEnv ?? SETTINGS_DEFAULTS[key];
  }
  return merged as T;
}
