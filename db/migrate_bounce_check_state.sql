-- Replace the per-campaign bounce_check_schedule with a single global counter.
-- The GraphQL delivery-failure query is zone-wide, so one counter drives the
-- bounce worker for all campaigns. Whenever a campaign sends, the worker tops
-- checks_to_go back up to 18 (capped); each 10-min cron tick runs one zone-wide
-- sync while > 0 and decrements, giving ~3 hours of fast bounce coverage.
DROP TABLE IF EXISTS bounce_check_schedule;

CREATE TABLE IF NOT EXISTS bounce_check_state (
  id           INTEGER PRIMARY KEY CHECK (id = 1),
  checks_to_go INTEGER NOT NULL DEFAULT 0,
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT OR IGNORE INTO bounce_check_state (id, checks_to_go) VALUES (1, 0);

-- The two former tuning settings are now hard-coded constants in the bounce
-- worker (18 checks, 10 min apart). Drop any stored overrides.
DELETE FROM settings WHERE key IN ('BOUNCE_CHECK_RUNS', 'BOUNCE_CHECK_INTERVAL_MINUTES');
