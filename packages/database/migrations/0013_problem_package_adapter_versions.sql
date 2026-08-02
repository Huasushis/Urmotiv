DO $$
BEGIN
  BEGIN
    LOCK TABLE "import_jobs", "export_jobs" IN ACCESS EXCLUSIVE MODE NOWAIT;
  EXCEPTION
    WHEN lock_not_available THEN
      RAISE EXCEPTION USING
        ERRCODE = '55006',
        MESSAGE = 'problem package adapter version migration requires the API and package workers to be stopped';
  END;
END;
$$;
--> statement-breakpoint
ALTER TABLE "import_jobs"
  ADD COLUMN "selected_format_version" varchar(80),
  ADD COLUMN "client_request_digest" char(64);
--> statement-breakpoint
UPDATE "import_jobs"
SET "selected_format_version" = CASE "selected_format"
  WHEN 'urmotiv' THEN '1.0.0'
  WHEN 'hydro' THEN '0.1.0'
  ELSE 'legacy-unbound'
END;
--> statement-breakpoint
ALTER TABLE "import_jobs"
  ALTER COLUMN "selected_format_version" SET NOT NULL,
  ADD CONSTRAINT "import_jobs_selected_format_version_ck" CHECK (
    "selected_format_version" ~ '^[0-9A-Za-z]+([._+-][0-9A-Za-z]+)*$'
  ),
  ADD CONSTRAINT "import_jobs_client_request_digest_ck" CHECK (
    "client_request_digest" IS NULL OR "client_request_digest" ~ '^[0-9a-f]{64}$'
  );
--> statement-breakpoint
ALTER TABLE "export_jobs"
  ADD COLUMN "target_format_version" varchar(80),
  ADD COLUMN "client_request_digest" char(64);
--> statement-breakpoint
UPDATE "export_jobs"
SET "target_format_version" = CASE "target_format"
  WHEN 'urmotiv' THEN '1.0.0'
  WHEN 'hydro' THEN '0.1.0'
  ELSE 'legacy-unbound'
END;
--> statement-breakpoint
ALTER TABLE "export_jobs"
  ALTER COLUMN "target_format_version" SET NOT NULL,
  ADD CONSTRAINT "export_jobs_target_format_version_ck" CHECK (
    "target_format_version" ~ '^[0-9A-Za-z]+([._+-][0-9A-Za-z]+)*$'
  ),
  ADD CONSTRAINT "export_jobs_client_request_digest_ck" CHECK (
    "client_request_digest" IS NULL OR "client_request_digest" ~ '^[0-9a-f]{64}$'
  );
