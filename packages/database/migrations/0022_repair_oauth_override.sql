-- 0021 intentionally left legacy system_settings untouched. Recover only the
-- default-disabled override that 0021 could not distinguish from no override.
-- The old settings writer updated revision and appended one of the two audit
-- actions below in the same transaction; that append-only record is the sole
-- authoritative discriminator.
DO $$
DECLARE
  legacy_row system_settings%ROWTYPE;
  oauth_update_count integer;
  general_update_count integer;
BEGIN
  SELECT * INTO legacy_row
  FROM system_settings
  WHERE id = 'global';

  IF NOT FOUND OR EXISTS (
    SELECT 1 FROM system_oauth_settings WHERE id = 'global'
  ) THEN
    RETURN;
  END IF;

  IF legacy_row.enabled
     OR legacy_row.authorize_url <> ''
     OR legacy_row.token_url <> ''
     OR legacy_row.profile_url <> ''
     OR legacy_row.redirect_uri <> '/api/v1/auth/ustc/callback'
     OR legacy_row.scope <> ''
     OR legacy_row.client_id_encrypted IS NOT NULL
     OR legacy_row.client_secret_encrypted IS NOT NULL THEN
    RAISE EXCEPTION 'OAUTH_OVERRIDE_REPAIR_IMPOSSIBLE: non-default legacy OAuth state has no migrated row';
  END IF;

  SELECT
    count(*) FILTER (
      WHERE action = 'auth.ustc_oauth.settings.update'
        AND object_type = 'system_settings'
    )::integer,
    count(*) FILTER (
      WHERE action = 'system.general_settings.update'
        AND object_type = 'system_settings'
    )::integer
  INTO oauth_update_count, general_update_count
  FROM audit_events
  WHERE object_type = 'system_settings'
    AND object_id = 'global'
    AND result = 'success'
    AND action IN (
      'auth.ustc_oauth.settings.update',
      'system.general_settings.update'
    );

  IF oauth_update_count > 0 THEN
    INSERT INTO system_oauth_settings (
      id, enabled, authorize_url, token_url, profile_url, redirect_uri, scope,
      client_id_encrypted, client_secret_encrypted, revision, updated_by_user_id,
      created_at, updated_at
    ) VALUES (
      legacy_row.id, legacy_row.enabled, legacy_row.authorize_url,
      legacy_row.token_url, legacy_row.profile_url, legacy_row.redirect_uri,
      legacy_row.scope, legacy_row.client_id_encrypted,
      legacy_row.client_secret_encrypted, legacy_row.revision,
      legacy_row.updated_by_user_id, legacy_row.created_at, legacy_row.updated_at
    ) ON CONFLICT (id) DO NOTHING;
    RETURN;
  END IF;

  -- No OAuth audit plus a complete general-settings audit means the legacy row
  -- is still the environment-fallback state. Leave the override table absent.
  IF legacy_row.revision - 1 = general_update_count THEN
    RETURN;
  END IF;

  RAISE EXCEPTION 'OAUTH_OVERRIDE_REPAIR_IMPOSSIBLE: default legacy OAuth state lacks authoritative audit evidence';
END
$$;
