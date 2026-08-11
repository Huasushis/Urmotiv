DO $$
BEGIN
  BEGIN
    LOCK TABLE "import_jobs" IN ACCESS EXCLUSIVE MODE NOWAIT;
  EXCEPTION
    WHEN lock_not_available THEN
      RAISE EXCEPTION USING
        ERRCODE = '55006',
        MESSAGE = 'import job execution lease migration requires the API and package workers to be stopped';
  END;
END;
$$;
--> statement-breakpoint
ALTER TABLE "import_jobs"
  ADD COLUMN "execution_attempt" integer NOT NULL DEFAULT 0,
  ADD COLUMN "lease_id" uuid,
  ADD COLUMN "lease_expires_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "import_jobs"
  ADD CONSTRAINT "import_jobs_execution_attempt_ck" CHECK ("execution_attempt" >= 0);
--> statement-breakpoint
CREATE INDEX "import_jobs_lease_expiry_idx"
  ON "import_jobs" ("lease_expires_at")
  WHERE "state" = 'running' AND "lease_expires_at" IS NOT NULL;
