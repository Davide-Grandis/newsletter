-- Public, double opt-in newsletter signup.
--
-- newsletters.slug             : clean public identifier used in the subscribe
--                                URL (/subscribe/<slug>). NULL until set; the
--                                unique index permits many NULLs (SQLite treats
--                                NULLs as distinct).
-- newsletters.allow_public_signup : per-newsletter switch. The public subscribe
--                                page only works when this is 1, so signup is
--                                opt-in and can't be abused on internal lists.
-- subscribers.confirm_token    : double opt-in token, separate from the
--                                unsubscribe `token` so a leaked verify link can
--                                never be used to unsubscribe (and vice-versa).
--                                Set while pending (verified=0); cleared on
--                                confirmation.
ALTER TABLE newsletters ADD COLUMN slug TEXT;
ALTER TABLE newsletters ADD COLUMN allow_public_signup INTEGER NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX IF NOT EXISTS idx_newsletters_slug ON newsletters(slug);

ALTER TABLE subscribers ADD COLUMN confirm_token TEXT;
