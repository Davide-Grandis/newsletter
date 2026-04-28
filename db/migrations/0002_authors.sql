-- 0002_authors: replace the ingest worker's ALLOWED_AUTHORS env var with a
-- D1 table managed via the admin worker (CRUD).

CREATE TABLE IF NOT EXISTS authors (
  email      TEXT PRIMARY KEY COLLATE NOCASE,
  name       TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
