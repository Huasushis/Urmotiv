ALTER TABLE system_settings
  ADD COLUMN IF NOT EXISTS email_login_enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS smtp_host text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS smtp_port integer NOT NULL DEFAULT 587,
  ADD COLUMN IF NOT EXISTS smtp_secure boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS smtp_username text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS smtp_password_encrypted text,
  ADD COLUMN IF NOT EXISTS smtp_from_email text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS smtp_from_name text NOT NULL DEFAULT 'Urmotiv';
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'system_settings_smtp_port_ck'
  ) THEN
    ALTER TABLE system_settings
      ADD CONSTRAINT system_settings_smtp_port_ck CHECK (smtp_port BETWEEN 1 AND 65535);
  END IF;
END $$;
