-- Global runtime configuration store, editable from the admin console's
-- Settings page. Each row overrides the matching worker env var / built-in
-- default; absent keys fall back to env then to the central defaults defined
-- in `shared/settings.ts`. Only keys in that allow-list are honoured on read.
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
