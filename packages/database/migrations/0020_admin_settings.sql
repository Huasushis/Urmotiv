ALTER TABLE problems
  ADD COLUMN IF NOT EXISTS origin varchar(100) NOT NULL DEFAULT 'native',
  ADD COLUMN IF NOT EXISTS import_batch varchar(200),
  ADD COLUMN IF NOT EXISTS import_source varchar(200);
--> statement-breakpoint
ALTER TABLE roles
  ADD COLUMN IF NOT EXISTS revision integer NOT NULL DEFAULT 1;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS problems_origin_batch_source_idx
  ON problems (origin, import_batch, import_source);
--> statement-breakpoint
WITH imported AS (
  SELECT DISTINCT ON (item.imported_problem_id)
    item.imported_problem_id,
    job.id::text AS import_batch,
    COALESCE(NULLIF(job.selected_format, ''), 'problem-package') AS import_source
  FROM import_job_items item
  JOIN import_jobs job ON job.id = item.job_id
  WHERE item.imported_problem_id IS NOT NULL
  ORDER BY item.imported_problem_id, job.created_at DESC, job.id DESC
)
UPDATE problems problem
SET origin = 'problem-package',
    import_batch = imported.import_batch,
    import_source = imported.import_source
FROM imported
WHERE problem.id = imported.imported_problem_id
  AND problem.origin = 'native';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS system_settings (
  id text PRIMARY KEY,
  enabled boolean NOT NULL DEFAULT false,
  authorize_url text NOT NULL DEFAULT '',
  token_url text NOT NULL DEFAULT '',
  profile_url text NOT NULL DEFAULT '',
  redirect_uri text NOT NULL DEFAULT '/api/v1/auth/ustc/callback',
  scope text NOT NULL DEFAULT '',
  public_registration_enabled boolean NOT NULL DEFAULT false,
  public_site_url text NOT NULL DEFAULT '',
  client_id_encrypted text,
  client_secret_encrypted text,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  updated_by_user_id bigint REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE system_settings
  ADD COLUMN IF NOT EXISTS public_registration_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS public_site_url text NOT NULL DEFAULT '';
--> statement-breakpoint
INSERT INTO system_settings (id)
VALUES ('global')
ON CONFLICT (id) DO NOTHING;
