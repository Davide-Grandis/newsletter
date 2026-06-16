-- Admin console roles and per-newsletter scoping.
--
-- Adds a role to each console user and a many-to-many mapping between admins
-- and the newsletters they may manage. Authentication remains Cloudflare
-- Access; this layer adds authorization (who can do what, and on which
-- newsletters).
--
--   * super_admin: full access to the application and global settings.
--   * admin:       scoped to one or more newsletters (admins_newsletters).
--
-- Bootstrap: nothing is seeded here. On first login, if the admins table is
-- empty the worker promotes the authenticated Access user to super_admin.

-- Existing rows (theme-only) default to 'admin'. The single bootstrap
-- super_admin is created at runtime, not seeded.
ALTER TABLE admins
  ADD COLUMN role TEXT NOT NULL DEFAULT 'admin'
    CHECK (role IN ('super_admin', 'admin'));

-- Newsletters an admin is allowed to manage. Super admins ignore this table
-- (they implicitly see every newsletter). Deleting a newsletter removes its
-- assignments; the application enforces that each newsletter keeps >= 1 admin.
CREATE TABLE IF NOT EXISTS admins_newsletters (
  email         TEXT NOT NULL COLLATE NOCASE,
  newsletter_id TEXT NOT NULL REFERENCES newsletters(id) ON DELETE CASCADE,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (email, newsletter_id)
);
CREATE INDEX IF NOT EXISTS idx_admins_newsletters_newsletter
  ON admins_newsletters(newsletter_id);
