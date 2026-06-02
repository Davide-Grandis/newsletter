-- Admin console users and their UI preferences.
-- Identity is supplied by Cloudflare Access; this table only persists per-user
-- settings (currently the theme) so the preference follows the user across
-- devices/browsers. The row is created on first login, seeded with the theme
-- the client detected (OS preference) at that moment.
CREATE TABLE IF NOT EXISTS admins (
  email      TEXT PRIMARY KEY COLLATE NOCASE,
  theme      TEXT NOT NULL DEFAULT 'light' CHECK (theme IN ('light','dark')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
