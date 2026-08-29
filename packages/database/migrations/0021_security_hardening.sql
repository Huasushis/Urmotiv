CREATE TABLE IF NOT EXISTS system_oauth_settings (
  id varchar(32) PRIMARY KEY,
  enabled boolean NOT NULL DEFAULT false,
  authorize_url text NOT NULL DEFAULT '',
  token_url text NOT NULL DEFAULT '',
  profile_url text NOT NULL DEFAULT '',
  redirect_uri text NOT NULL DEFAULT '/api/v1/auth/ustc/callback',
  scope text NOT NULL DEFAULT '',
  client_id_encrypted text,
  client_secret_encrypted text,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  updated_by_user_id bigint REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
INSERT INTO system_oauth_settings (
  id, enabled, authorize_url, token_url, profile_url, redirect_uri, scope,
  client_id_encrypted, client_secret_encrypted, revision, updated_by_user_id,
  created_at, updated_at
)
SELECT
  id, enabled, authorize_url, token_url, profile_url, redirect_uri, scope,
  client_id_encrypted, client_secret_encrypted, revision, updated_by_user_id,
  created_at, updated_at
FROM system_settings
WHERE id = 'global'
  AND (
    enabled
    OR authorize_url <> ''
    OR token_url <> ''
    OR profile_url <> ''
    OR redirect_uri <> '/api/v1/auth/ustc/callback'
    OR scope <> ''
    OR client_id_encrypted IS NOT NULL
    OR client_secret_encrypted IS NOT NULL
  )
ON CONFLICT (id) DO NOTHING;
--> statement-breakpoint
DELETE FROM role_memberships membership
USING roles role
WHERE membership.role_id = role.id
  AND (
    (role.key = 'root' AND membership.user_id <> 0)
    OR (role.key <> 'root' AND membership.user_id = 0)
  );
--> statement-breakpoint
INSERT INTO role_memberships (id, user_id, role_id, granted_by_user_id, reason)
SELECT '00000000-0000-4000-8000-000000000000'::uuid, 0, role.id, 0, '首次初始化 root 账号'
FROM roles role
WHERE role.key = 'root'
ON CONFLICT (user_id, role_id) WHERE revoked_at IS NULL DO NOTHING;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION enforce_root_role_membership()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  role_key text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    SELECT key INTO role_key FROM roles WHERE id = OLD.role_id;
    IF role_key = 'root' OR OLD.user_id = 0 THEN
      RAISE EXCEPTION 'root role membership is fixed' USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;
  SELECT key INTO role_key FROM roles WHERE id = NEW.role_id;
  IF role_key = 'root' THEN
    IF NEW.user_id <> 0 OR NEW.revoked_at IS NOT NULL OR NEW.revoked_by_user_id IS NOT NULL THEN
      RAISE EXCEPTION 'root role membership is fixed' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW.user_id = 0 THEN
    RAISE EXCEPTION 'root user cannot join another role' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'role_memberships_root_guard'
  ) THEN
    CREATE TRIGGER role_memberships_root_guard
    BEFORE INSERT OR UPDATE OR DELETE ON role_memberships
    FOR EACH ROW EXECUTE FUNCTION enforce_root_role_membership();
  END IF;
END;
$$;
