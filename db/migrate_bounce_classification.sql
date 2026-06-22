-- Migration: split bounce counters and record last-bounce classification.
--
-- Run once against the live D1 database:
--   npx wrangler d1 execute newsletter_db --remote \
--     --file=db/migrate_bounce_classification.sql
--
-- What it does:
--   1. Adds hard_bounce_count / soft_bounce_count (split from the combined
--      bounce_count, which is kept as the lifetime total).
--   2. Adds last_bounce_type ('hard'|'soft'|'block') and last_bounce_code
--      (raw RFC 3463 status, e.g. '5.1.1') for the Subscribers UI.
--   3. Best-effort seed: any subscriber already marked 'bounced' is assumed to
--      have hard-bounced (that was the only path that disabled before), so its
--      existing bounce_count is attributed to hard_bounce_count. All other
--      historical bounces are attributed to soft (non-disabling).
--
-- SQLite has no DROP COLUMN on older versions; bounce_count is intentionally
-- left in place as the combined total.

ALTER TABLE subscribers ADD COLUMN hard_bounce_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE subscribers ADD COLUMN soft_bounce_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE subscribers ADD COLUMN last_bounce_type  TEXT;
ALTER TABLE subscribers ADD COLUMN last_bounce_code  TEXT;

-- Seed: disabled subscribers were disabled by a hard bounce under the old
-- single-counter model — attribute their count to hard.
UPDATE subscribers
SET hard_bounce_count = bounce_count,
    last_bounce_type   = 'hard'
WHERE status = 'bounced' AND bounce_count > 0;

-- Everyone else who bounced but stayed active: those were transient (soft).
UPDATE subscribers
SET soft_bounce_count = bounce_count,
    last_bounce_type   = 'soft'
WHERE status <> 'bounced' AND bounce_count > 0;
