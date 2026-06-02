-- Per-newsletter sender address. NULL falls back to the global FROM_ADDRESS
-- setting. Must be on the configured sending domain (validated by the admin API).
ALTER TABLE newsletters ADD COLUMN from_address TEXT;
