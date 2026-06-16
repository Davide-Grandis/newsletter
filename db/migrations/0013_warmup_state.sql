-- Warmup is now stateful and demand-driven (no fixed start date). A single
-- row tracks where the sender is in the weekly ramp and caches the daily
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
