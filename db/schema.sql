-- Newsletter D1 schema

PRAGMA foreign_keys = ON;

-- A newsletter is an independent mailing list with its own inbound address,
-- author allow-list and subscriber list. Inbound email is routed to a
-- newsletter by matching the recipient address against `inbound_address`.
CREATE TABLE IF NOT EXISTS newsletters (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  inbound_address TEXT NOT NULL UNIQUE COLLATE NOCASE,
  enabled         INTEGER NOT NULL DEFAULT 1,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Seed a default newsletter so a fresh install works out of the box.
INSERT OR IGNORE INTO newsletters (id, name, inbound_address, enabled)
  VALUES ('default', 'Default', 'newsletter@eneanewsletter.it', 1);

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

-- Admin console users. Identity is provided by Cloudflare Access; this table
-- only stores per-user UI preferences so the chosen theme follows the user
-- across devices/browsers. A row is created on first login, seeded with the
-- theme the client detected (OS preference) at that time.
CREATE TABLE IF NOT EXISTS admins (
  email      TEXT PRIMARY KEY COLLATE NOCASE,
  theme      TEXT NOT NULL DEFAULT 'light' CHECK (theme IN ('light','dark')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Global runtime configuration, editable from the admin console's Settings
-- page. A row overrides the corresponding worker env var / built-in default;
-- absent keys fall back to env then to the central defaults in
-- `shared/settings.ts`. Only keys in that file's allow-list are honoured.
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
