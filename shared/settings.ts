// Central runtime configuration shared by every worker.
//
// Tunables are overridable at runtime via the D1 `settings` table, edited from
// the admin console's Settings page. Resolution order for any key is just two
// levels: D1 `settings` row -> built-in default below.
//
// `SETTINGS_DEFAULTS` is the single source of truth for every configurable
// value; workers no longer declare these as `[vars]` in `wrangler.toml`.
// (Secrets and bindings — signing keys, API tokens, D1/R2/queue bindings —
// are NOT settings and still live in wrangler.)

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

// Built-in defaults — the single source of truth for every configurable value.
// Deployment-specific values (zone id, domains, sending identity) live here too
// now that worker `[vars]` are gone; edit them here or override per-deployment
// via the D1 `settings` table (Settings page).
export const SETTINGS_DEFAULTS: Record<SettingKey, string> = {
  EMAIL_ROUTING_ZONE_ID: '48ea553ff7c20557f7596ba55eb4cb5e',
  INGEST_WORKER_NAME: 'newsletter-ingest',
  BASE_DOMAIN: 'eneanewsletter.it',
  FROM_ADDRESS: 'Newsletter <newsletter@eneanewsletter.it>',
  BOUNCE_DOMAIN: 'eneanewsletter.it',
  TRACKING_BASE_URL: 'https://track.eneanewsletter.it',
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
 * `settings` table, falling back to the built-in defaults. Bindings and secrets
 * on `env` are preserved untouched; only allow-listed string keys are overlaid,
 * so the settings table can never inject a value for a binding or secret.
 */
export async function loadSettings<T extends object>(
  db: D1Database,
  env: T,
): Promise<T> {
  const stored = await readStoredSettings(db);
  const merged: Record<string, unknown> = { ...(env as Record<string, unknown>) };
  for (const key of SETTING_KEYS) {
    // Two-level resolution: D1 `settings` row -> built-in default.
    merged[key] = stored.get(key) ?? SETTINGS_DEFAULTS[key];
  }
  return merged as T;
}
