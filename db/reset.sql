-- Destructive reset: drops every table so schema.sql can recreate the DB from
-- scratch. Use ONLY when the existing data is disposable.
--
--   wrangler d1 execute newsletter_db --remote --file=db/reset.sql
--   wrangler d1 execute newsletter_db --remote --file=db/schema.sql

PRAGMA foreign_keys = OFF;

DROP TABLE IF EXISTS events;
DROP TABLE IF EXISTS sends;
DROP TABLE IF EXISTS attachments;
DROP TABLE IF EXISTS campaigns;
DROP TABLE IF EXISTS subscribers;
DROP TABLE IF EXISTS authors;
DROP TABLE IF EXISTS newsletters;

PRAGMA foreign_keys = ON;
