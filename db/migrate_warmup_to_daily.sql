-- Migration: switch warmup_state from weekly-level model to daily-progression model.
--
-- Run once against the live D1 database:
--   npx wrangler d1 execute newsletter_db --remote \
--     --file=db/migrate_warmup_to_daily.sql
--
-- What it does:
--   1. Adds the new columns (day, day_started_at).
--   2. Seeds day/day_started_at from the old level/week_started_at where they
--      exist, so running deployments resume warmup roughly where they left off
--      (best-effort; the mapping is approximate since weeks ≠ days).
--   3. Leaves the old columns in place — SQLite does not support DROP COLUMN
--      on all versions, and keeping them is harmless.

ALTER TABLE warmup_state ADD COLUMN day            INTEGER;
ALTER TABLE warmup_state ADD COLUMN day_started_at TEXT;

-- Seed: map old level (0-based week) to an approximate warmup day.
-- Each warmup week ~ 7 days; level 0 → day 1, level N → day min(N*7+1, 30).
-- Only applies when warmup had already started (level IS NOT NULL).
UPDATE warmup_state
SET
  day            = MIN(COALESCE(level, 0) * 7 + 1, 30),
  day_started_at = CASE
                     WHEN week_started_at IS NOT NULL
                     THEN substr(week_started_at, 1, 10)
                     ELSE date('now')
                   END
WHERE id = 1 AND level IS NOT NULL;
