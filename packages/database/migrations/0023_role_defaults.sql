CREATE TABLE IF NOT EXISTS role_defaults (
  id varchar(32) PRIMARY KEY,
  human_role_key varchar(80) NOT NULL,
  robot_role_key varchar(80) NOT NULL,
  revision integer NOT NULL DEFAULT 1,
  updated_by_user_id bigint REFERENCES users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT role_defaults_id_ck CHECK (id = 'global'),
  CONSTRAINT role_defaults_revision_ck CHECK (revision > 0)
);
