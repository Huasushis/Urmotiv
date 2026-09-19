ALTER TABLE problems
  ADD COLUMN IF NOT EXISTS external_review_enabled boolean NOT NULL DEFAULT true;
