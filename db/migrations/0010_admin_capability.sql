-- Per-admin capability: read-only (default) vs edit.
--
-- Regular admins (role = 'admin') now carry a capability that governs what they
-- may do on the newsletters they are assigned to:
--
--   * read_only: view subscribers, authors, campaigns and analytics, but make
--                no changes and not manage admins.
--   * edit:      full content management on their newsletters AND the ability
--                to add/remove admins there and set their capability.
--
-- super_admins ignore this column (they always have full access). New admins
-- default to read_only; an edit-admin or super_admin can promote them.
--
-- Existing admins are promoted to 'edit' to preserve today's behaviour (before
-- this change every assigned admin had full edit access).

ALTER TABLE admins
  ADD COLUMN capability TEXT NOT NULL DEFAULT 'read_only'
    CHECK (capability IN ('read_only', 'edit'));

UPDATE admins SET capability = 'edit' WHERE role = 'admin';
