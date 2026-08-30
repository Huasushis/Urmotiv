ALTER TABLE system_oauth_settings
  ADD COLUMN IF NOT EXISTS auto_create_users boolean NOT NULL DEFAULT true;
