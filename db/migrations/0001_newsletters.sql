-- Migration 0001: introduce per-newsletter scoping.
--
-- Adds a `newsletters` table and scopes authors, subscribers and campaigns to
-- a newsletter. All existing rows are assigned to a seeded 'default'
-- newsletter so nothing is lost. Subscriber ids are preserved so existing
-- `sends`/`events` foreign keys keep pointing at the right rows.
--
-- Run once against the live DB:
--   wrangler d1 execute newsletter_db --remote --file=db/migrations/0001_newsletters.sql
--
-- Idempotency: this migration is NOT idempotent (it rebuilds tables). Run it
-- exactly once. Guard: it will fail fast if `newsletters` already exists.

PRAGMA foreign_keys = OFF;

-- 1. Newsletters + default row.
CREATE TABLE newsletters (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  inbound_address TEXT NOT NULL UNIQUE COLLATE NOCASE,
  enabled         INTEGER NOT NULL DEFAULT 1,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO newsletters (id, name, inbound_address, enabled)
  VALUES ('default', 'Default', 'newsletter@eneanewsletter.it', 1);

-- 2. Authors: rebuild with composite (newsletter_id, email) primary key.
CREATE TABLE authors_new (
  newsletter_id TEXT NOT NULL REFERENCES newsletters(id) ON DELETE CASCADE,
  email         TEXT NOT NULL COLLATE NOCASE,
  name          TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (newsletter_id, email)
);
INSERT INTO authors_new (newsletter_id, email, name, created_at)
  SELECT 'default', email, name, created_at FROM authors;
DROP TABLE authors;
ALTER TABLE authors_new RENAME TO authors;

-- 3. Subscribers: rebuild with newsletter_id + UNIQUE(newsletter_id, email),
--    preserving ids.
CREATE TABLE subscribers_new (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  newsletter_id   TEXT NOT NULL REFERENCES newsletters(id) ON DELETE CASCADE,
  email           TEXT NOT NULL,
  name            TEXT,
  status          TEXT NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active','unsubscribed','bounced','complained')),
  subscribed_at   TEXT NOT NULL DEFAULT (datetime('now')),
  unsubscribed_at TEXT,
  bounce_count    INTEGER NOT NULL DEFAULT 0,
  last_bounce_at  TEXT,
  token           TEXT NOT NULL,
  UNIQUE (newsletter_id, email)
);
INSERT INTO subscribers_new
    (id, newsletter_id, email, name, status, subscribed_at, unsubscribed_at, bounce_count, last_bounce_at, token)
  SELECT id, 'default', email, name, status, subscribed_at, unsubscribed_at, bounce_count, last_bounce_at, token
  FROM subscribers;
DROP TABLE subscribers;
ALTER TABLE subscribers_new RENAME TO subscribers;
CREATE INDEX idx_subscribers_status ON subscribers(status);
CREATE INDEX idx_subscribers_newsletter ON subscribers(newsletter_id);

-- 4. Campaigns: add newsletter_id (existing rows default to 'default').
ALTER TABLE campaigns ADD COLUMN newsletter_id TEXT NOT NULL DEFAULT 'default' REFERENCES newsletters(id);
CREATE INDEX idx_campaigns_newsletter ON campaigns(newsletter_id);

PRAGMA foreign_keys = ON;
