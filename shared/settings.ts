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
  // -- Access / user management --
  // The Cloudflare Zero Trust Emails list the admin worker keeps in sync as
  // console users are added/removed, plus the account it lives in. A Cloudflare
  // Access policy references this list to guard the console; the worker only
  // edits list membership, never the policy itself. Non-sensitive identifiers;
  // the Zero Trust API token is a Worker Secret (CF_ZT_API_TOKEN), not a
  // setting. ACCESS_ACCOUNT_ID is required because lists are account-scoped.
  'ACCESS_ACCOUNT_ID',
  'ACCESS_LIST_ID',
  // Global toggle relaxing admin (non-super) permissions. Default OFF.
  // (Managing admins is no longer a global setting — it is governed per-admin
  // by the read-only/edit capability.)
  'ALLOW_ADMIN_NEWSLETTER_CRUD',
  // -- Sending identity --
  // (Bounce/return-path traffic uses BASE_DOMAIN; there is no separate
  // bounce domain setting.)
  'FROM_ADDRESS',
  'TRACKING_BASE_URL',
  // Global default email footer (HTML + plain text). A newsletter's own footer
  // overrides these; an empty newsletter footer inherits them. Supports the
  // {{unsubscribe_url}}, {{newsletter_name}} and {{email}} tokens.
  'DEFAULT_FOOTER_HTML',
  'DEFAULT_FOOTER_TEXT',
  // -- Tracking --
  'TRACKING_ENABLED',
  // -- Public signup --
  // Cloudflare Turnstile site key (public) for the public subscribe page. The
  // matching secret is a Worker Secret (TURNSTILE_SECRET_KEY), not a setting.
  // Empty disables bot protection (and, by safety, the public signup page).
  'TURNSTILE_SITE_KEY',
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
  // Warmup is always on and demand-driven (no start date). The weekly ramp is
  // a JSON array of weekly ceilings; steady state is the last element. The
  // daily cap is read live from the Cloudflare API; DAILY_CAP_FALLBACK is
  // used only when that read fails.
  'WARMUP_SCHEDULE',
  'DAILY_CAP_FALLBACK',
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
  // No built-in default: the Email Routing zone is deployment-specific and is
  // configured exclusively via the D1 `settings` table (Settings page).
  EMAIL_ROUTING_ZONE_ID: '',
  INGEST_WORKER_NAME: 'newsletter-ingest',
  // No built-in default: the sending domain is deployment-specific and lives
  // only in the D1 `settings` table. Saving it auto-resolves EMAIL_ROUTING_ZONE_ID.
  BASE_DOMAIN: '',
  // Empty until the Zero Trust Emails list is provisioned; set from the Settings
  // page (Access tab) so console user management can sync list membership.
  ACCESS_ACCOUNT_ID: '',
  ACCESS_LIST_ID: '',
  ALLOW_ADMIN_NEWSLETTER_CRUD: 'false',
  FROM_ADDRESS: 'Newsletter <newsletter@yourdomain.com>',
  TRACKING_BASE_URL: 'https://track.yourdomain.com',
  // Global default footer. Newsletters with an empty footer inherit these.
  // {{unsubscribe_url}} is always honoured; if a footer omits it the consumer
  // appends an unsubscribe line anyway. {{newsletter_name}}/{{email}} are
  // optional personalisation tokens.
  DEFAULT_FOOTER_HTML:
    '<hr style="border:none;border-top:1px solid #e2e8f0;margin:24px 0 12px">\n' +
    '<p style="font-size:12px;line-height:1.5;color:#64748b;margin:0">\n' +
    'You are receiving this email because you subscribed to {{newsletter_name}}.<br>\n' +
    '<a href="{{unsubscribe_url}}" style="color:#64748b">Unsubscribe</a> at any time.\n' +
    '</p>',
  DEFAULT_FOOTER_TEXT:
    '--\n' +
    'You are receiving this email because you subscribed to {{newsletter_name}}.\n' +
    'Unsubscribe: {{unsubscribe_url}}',
  TRACKING_ENABLED: 'true',
  // Empty by default: set the Turnstile site key from the Settings page once the
  // widget exists. Empty means the public signup page is unavailable.
  TURNSTILE_SITE_KEY: '',
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
  WARMUP_SCHEDULE: '[500, 1500, 5000, 12000, 25000, 40000]',
  DAILY_CAP_FALLBACK: '1000',
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
