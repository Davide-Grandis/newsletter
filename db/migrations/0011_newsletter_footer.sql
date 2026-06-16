-- Per-newsletter customizable email footer (HTML + plain-text variants).
-- A NULL/empty value falls back to the global DEFAULT_FOOTER_HTML /
-- DEFAULT_FOOTER_TEXT settings. The unsubscribe link is guaranteed by the
-- consumer regardless of footer content (see shared/footer.ts): footers may
-- include a {{unsubscribe_url}} token, and one is auto-appended if omitted.
ALTER TABLE newsletters ADD COLUMN footer_html TEXT;
ALTER TABLE newsletters ADD COLUMN footer_text TEXT;
