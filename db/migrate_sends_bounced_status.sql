-- Add 'bounced' as a valid status in the sends table.
-- SQLite requires table recreation to modify a CHECK constraint.
CREATE TABLE sends_new (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id    TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  subscriber_id  INTEGER NOT NULL REFERENCES subscribers(id) ON DELETE CASCADE,
  status         TEXT NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending','sent','failed','bounced')),
  queued_at      TEXT NOT NULL DEFAULT (datetime('now')),
  sent_at        TEXT,
  error          TEXT,
  message_id     TEXT,
  UNIQUE (campaign_id, subscriber_id)
);
INSERT INTO sends_new SELECT id, campaign_id, subscriber_id, status, queued_at, sent_at, error, message_id FROM sends;
DROP TABLE sends;
ALTER TABLE sends_new RENAME TO sends;
CREATE INDEX IF NOT EXISTS idx_sends_campaign_status ON sends(campaign_id, status);
