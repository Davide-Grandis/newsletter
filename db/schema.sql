-- Newsletter D1 schema

PRAGMA foreign_keys = ON;

-- A newsletter is an independent mailing list with its own inbound address,
-- author allow-list and subscriber list. Inbound email is routed to a
-- newsletter by matching the recipient address against `inbound_address`.
CREATE TABLE IF NOT EXISTS newsletters (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  inbound_address TEXT NOT NULL UNIQUE COLLATE NOCASE,
  -- Optional per-newsletter sender (the outgoing `From:`). NULL falls back to
  -- the global FROM_ADDRESS setting. Must be on the configured sending domain.
  from_address    TEXT,
  -- Optional per-newsletter email footer (HTML + plain text). NULL/empty falls
  -- back to the global DEFAULT_FOOTER_HTML / DEFAULT_FOOTER_TEXT settings. May
  -- contain {{unsubscribe_url}}, {{newsletter_name}}, {{email}} tokens; the
  -- consumer always guarantees an unsubscribe link (see shared/footer.ts).
  footer_html     TEXT,
  footer_text     TEXT,
  -- Clean public identifier for the subscribe URL (/subscribe/<slug>). NULL
  -- until set; the unique index allows many NULLs.
  slug            TEXT,
  -- Per-newsletter switch: the public subscribe page only works when this is 1.
  allow_public_signup INTEGER NOT NULL DEFAULT 0,
  enabled         INTEGER NOT NULL DEFAULT 1,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Newsletter names must be unique, case-insensitively.
CREATE UNIQUE INDEX IF NOT EXISTS idx_newsletters_name ON newsletters(name COLLATE NOCASE);
CREATE UNIQUE INDEX IF NOT EXISTS idx_newsletters_slug ON newsletters(slug);


-- Authors authorized to send a given newsletter by emailing the ingest worker.
-- Inbound email's `From:` header is checked against this table, scoped to the
-- recipient newsletter (case-insensitive).
CREATE TABLE IF NOT EXISTS authors (
  newsletter_id TEXT NOT NULL REFERENCES newsletters(id) ON DELETE CASCADE,
  email         TEXT NOT NULL COLLATE NOCASE,
  name          TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (newsletter_id, email)
);

CREATE TABLE IF NOT EXISTS subscribers (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  newsletter_id   TEXT NOT NULL REFERENCES newsletters(id) ON DELETE CASCADE,
  email           TEXT NOT NULL,
  name            TEXT,
  verified        INTEGER NOT NULL DEFAULT 0 CHECK (verified IN (0,1)),
  status          TEXT NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active','unsubscribed','bounced','complained')),
  subscribed_at   TEXT NOT NULL DEFAULT (datetime('now')),
  unsubscribed_at TEXT,
  bounce_count    INTEGER NOT NULL DEFAULT 0,
  last_bounce_at  TEXT,
  token           TEXT NOT NULL,
  -- Double opt-in token, separate from `token` (the unsubscribe token). Set
  -- while a public signup is pending (verified=0); cleared on confirmation.
  confirm_token   TEXT,
  UNIQUE (newsletter_id, email)
);
CREATE INDEX IF NOT EXISTS idx_subscribers_status ON subscribers(status);
CREATE INDEX IF NOT EXISTS idx_subscribers_newsletter ON subscribers(newsletter_id);

CREATE TABLE IF NOT EXISTS campaigns (
  id                      TEXT PRIMARY KEY,
  newsletter_id           TEXT NOT NULL DEFAULT 'default' REFERENCES newsletters(id),
  subject                 TEXT NOT NULL,
  html                    TEXT,
  text                    TEXT,
  sent_by                 TEXT NOT NULL,
  created_at              TEXT NOT NULL DEFAULT (datetime('now')),
  status                  TEXT NOT NULL DEFAULT 'queued'
                            CHECK (status IN ('queued','sending','done','failed')),
  total_recipients        INTEGER NOT NULL DEFAULT 0,
  sent_count              INTEGER NOT NULL DEFAULT 0,
  failed_count            INTEGER NOT NULL DEFAULT 0,
  attachment_count        INTEGER NOT NULL DEFAULT 0,
  attachment_total_bytes  INTEGER NOT NULL DEFAULT 0,
  link_mode               INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_campaigns_newsletter ON campaigns(newsletter_id);

CREATE TABLE IF NOT EXISTS attachments (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id   TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  r2_key        TEXT NOT NULL,
  filename      TEXT NOT NULL,
  content_type  TEXT NOT NULL,
  size          INTEGER NOT NULL,
  sha256        TEXT NOT NULL,
  content_id    TEXT,
  disposition   TEXT NOT NULL DEFAULT 'attachment'
                  CHECK (disposition IN ('attachment','inline')),
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_attachments_campaign ON attachments(campaign_id);

CREATE TABLE IF NOT EXISTS sends (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id    TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  subscriber_id  INTEGER NOT NULL REFERENCES subscribers(id) ON DELETE CASCADE,
  status         TEXT NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending','sent','failed')),
  queued_at      TEXT NOT NULL DEFAULT (datetime('now')),
  sent_at        TEXT,
  error          TEXT,
  message_id     TEXT,
  UNIQUE (campaign_id, subscriber_id)
);
CREATE INDEX IF NOT EXISTS idx_sends_campaign_status ON sends(campaign_id, status);

CREATE TABLE IF NOT EXISTS events (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id    TEXT REFERENCES campaigns(id) ON DELETE CASCADE,
  subscriber_id  INTEGER REFERENCES subscribers(id) ON DELETE SET NULL,
  type           TEXT NOT NULL
                   CHECK (type IN ('open','click','bounce','complaint','unsubscribe','download')),
  attachment_id  INTEGER REFERENCES attachments(id) ON DELETE SET NULL,
  url            TEXT,
  ts             TEXT NOT NULL DEFAULT (datetime('now')),
  ua             TEXT,
  ip             TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_campaign_type ON events(campaign_id, type);

-- Application / pipeline activity log. Unlike `events` (recipient engagement),
-- this captures the campaign processing pipeline: ingest worker firing, queue
-- enqueue details, and consumer send activity. Written best-effort by the
-- workers (failures here never break the pipeline) and surfaced, merged with
-- engagement events, on the admin console's Logs page.
CREATE TABLE IF NOT EXISTS logs (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  ts             TEXT NOT NULL DEFAULT (datetime('now')),
  level          TEXT NOT NULL DEFAULT 'info'
                   CHECK (level IN ('debug','info','warn','error')),
  source         TEXT NOT NULL,   -- worker name: ingest|consumer|admin|bounce|tracker
  event          TEXT NOT NULL,   -- machine code e.g. 'ingest.received','queue.enqueued'
  campaign_id    TEXT,
  newsletter_id  TEXT,
  message        TEXT,            -- human-readable summary
  detail         TEXT             -- optional JSON blob
);
CREATE INDEX IF NOT EXISTS idx_logs_ts ON logs(ts);
CREATE INDEX IF NOT EXISTS idx_logs_campaign ON logs(campaign_id);

-- Admin console users. Identity is provided by Cloudflare Access; this table
-- stores each user's role and per-user UI preferences (theme follows the user
-- across devices/browsers). On first login, if this table is empty the worker
-- promotes the authenticated Access user to super_admin (bootstrap); otherwise
-- a row is created/updated as the user is managed from the console.
--
--   * super_admin: full access to the application and global settings.
--   * admin:       scoped to the newsletters listed in admins_newsletters.
-- In case of conflict, super_admin wins.
CREATE TABLE IF NOT EXISTS admins (
  email      TEXT PRIMARY KEY COLLATE NOCASE,
  role       TEXT NOT NULL DEFAULT 'admin' CHECK (role IN ('super_admin','admin')),
  -- For role='admin' only: read_only (view) vs edit (manage content + admins).
  -- super_admins ignore this. New admins default to read_only.
  capability TEXT NOT NULL DEFAULT 'read_only' CHECK (capability IN ('read_only','edit')),
  theme      TEXT NOT NULL DEFAULT 'light' CHECK (theme IN ('light','dark')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Newsletters an admin is allowed to manage (many-to-many). Super admins
-- ignore this table (they implicitly see every newsletter). Deleting a
-- newsletter removes its assignments; the application enforces that each
-- newsletter keeps at least one admin.
CREATE TABLE IF NOT EXISTS admins_newsletters (
  email         TEXT NOT NULL COLLATE NOCASE,
  newsletter_id TEXT NOT NULL REFERENCES newsletters(id) ON DELETE CASCADE,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (email, newsletter_id)
);
CREATE INDEX IF NOT EXISTS idx_admins_newsletters_newsletter
  ON admins_newsletters(newsletter_id);

-- Global runtime configuration, editable from the admin console's Settings
-- page. D1 is the canonical source of truth for all setting defaults; the
-- INSERT OR IGNORE block below seeds them on first schema application.
-- `shared/settings.ts` SETTINGS_DEFAULTS are an emergency fallback only
-- (used when the settings table is absent or a key has no row).
-- Only keys in that file's allow-list are honoured by workers.
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Default values. INSERT OR IGNORE means existing rows (manual overrides)
-- are never overwritten when the schema is re-applied.
INSERT OR IGNORE INTO settings (key, value) VALUES
  ('INGEST_WORKER_NAME',          'newsletter-ingest'),
  ('ALLOW_ADMIN_NEWSLETTER_CRUD', 'false'),
  ('FROM_ADDRESS',                'Newsletter <newsletter@yourdomain.com>'),
  ('TRACKING_BASE_URL',           'https://track.yourdomain.com'),
  ('DEFAULT_FOOTER_HTML',
    '<hr style="border:none;border-top:1px solid #e2e8f0;margin:24px 0 12px">
<p style="font-size:12px;line-height:1.5;color:#64748b;margin:0">
You are receiving this email because you subscribed to {{newsletter_name}}.<br>
<a href="{{unsubscribe_url}}" style="color:#64748b">Unsubscribe</a> at any time.
</p>'),
  ('DEFAULT_FOOTER_TEXT',
    '--
You are receiving this email because you subscribed to {{newsletter_name}}.
Unsubscribe: {{unsubscribe_url}}'),
  ('TRACKING_ENABLED',                'true'),
  ('MAX_ATTACHMENT_BYTES',            '10485760'),
  ('MAX_TOTAL_ATTACHMENT_BYTES',      '20971520'),
  ('MAX_ATTACHMENT_COUNT',            '10'),
  ('ALLOWED_MIME',                    'image/*,application/pdf,text/plain,text/csv,application/zip'),
  ('BLOCKED_EXTENSIONS',              'exe,js,bat,cmd,scr,com,vbs,ps1'),
  ('ATTACHMENT_LINK_THRESHOLD_BYTES', '8388608'),
  ('BATCH_SIZE',                      '100'),
  ('MAX_RAW_BYTES',                   '39000000'),
  ('RETENTION_DAYS',                  '90'),
  ('HARD_BOUNCE_THRESHOLD',           '1'),
  ('SOFT_BOUNCE_THRESHOLD',           '5'),
  ('WARMUP_SCHEDULE',                 '[500, 1500, 5000, 12000, 25000, 40000]'),
  ('DAILY_CAP_FALLBACK',              '1000');

-- Warmup is stateful and demand-driven (no fixed start date). A single row
-- (id=1) tracks where the sender is in the weekly ramp and caches the daily
-- sending quota read from the Cloudflare API once per UTC day.
--
--   level           : current warmup week index (0-based) into the weekly
--                     schedule; NULL until warmup starts (demand first > 499).
--   week_started_at : UTC 'YYYY-MM-DD HH:MM:SS' start of the current 7-day
--                     weekly window. The weekly cap counts sends since this.
--   daily_cap       : last daily sending cap read from the Cloudflare API,
--                     normalized to a per-day figure. NULL until first read.
--   daily_cap_date  : UTC 'YYYY-MM-DD' the daily cap was read (refreshed once
--                     per day by the consumer before it processes the queue).
CREATE TABLE IF NOT EXISTS warmup_state (
  id              INTEGER PRIMARY KEY CHECK (id = 1),
  level           INTEGER,
  week_started_at TEXT,
  daily_cap       INTEGER,
  daily_cap_date  TEXT,
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT OR IGNORE INTO warmup_state (id, level, week_started_at) VALUES (1, NULL, NULL);
