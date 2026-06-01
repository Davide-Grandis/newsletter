-- Add a `verified` flag to subscribers (boolean stored as 0/1, default 0 = False).
ALTER TABLE subscribers ADD COLUMN verified INTEGER NOT NULL DEFAULT 0;
