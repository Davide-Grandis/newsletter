-- Add the post-send bounce-check schedule table.
-- After a campaign finishes a sending round, the cleanup worker enqueues a
-- short burst of delivery-failure syncs (BOUNCE_CHECK_RUNS times, every
-- BOUNCE_CHECK_INTERVAL_MINUTES) instead of waiting for the daily sync.
CREATE TABLE IF NOT EXISTS bounce_check_schedule (
  campaign_id      TEXT PRIMARY KEY REFERENCES campaigns(id) ON DELETE CASCADE,
  runs_remaining   INTEGER NOT NULL,
  next_run_at      TEXT NOT NULL,
  interval_minutes INTEGER NOT NULL DEFAULT 30,
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_bounce_sched_next ON bounce_check_schedule(next_run_at);
