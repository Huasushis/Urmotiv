ALTER TABLE "export_jobs"
  ADD COLUMN "report" jsonb NOT NULL DEFAULT '{"version":1,"phase":"queued","completedItems":0,"failedItems":0,"skippedItems":0}'::jsonb;
