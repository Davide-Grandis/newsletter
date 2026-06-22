-- Migration: strip redundant source prefix from log events.
--
-- Run once against the live D1 database:
--   npx wrangler d1 execute newsletter_db --remote \
--     --file=db/migrate_strip_event_prefix.sql
--
-- Before: event = 'consumer.send_success', source = 'consumer'
-- After:  event = 'send_success',           source = 'consumer'
--
-- Rows whose event does NOT start with '<source>.' are left untouched.

UPDATE logs
SET event = SUBSTR(event, LENGTH(source) + 2)
WHERE SUBSTR(event, 1, LENGTH(source) + 1) = source || '.';
