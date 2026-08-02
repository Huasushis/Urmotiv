DO $$
BEGIN
  BEGIN
    LOCK TABLE
      "review_assignments",
      "tag_catalog_state"
    IN ACCESS EXCLUSIVE MODE NOWAIT;
  EXCEPTION
    WHEN lock_not_available THEN
      RAISE EXCEPTION USING
        ERRCODE = '55006',
        MESSAGE = 'robot tag catalog snapshot migration requires the API to be stopped and database transactions to be drained';
  END;

  IF EXISTS (
    SELECT 1
    FROM review_assignments assignment
    WHERE assignment.assignment_kind = 'robot'
      AND assignment.closure_reason IS NULL
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '55006',
      MESSAGE = 'robot tag catalog snapshot migration requires all robot leases to finish';
  END IF;
END;
$$;
--> statement-breakpoint
ALTER TABLE "review_assignments"
  ADD COLUMN "claimed_tag_catalog_version" integer;
--> statement-breakpoint
ALTER TABLE "review_assignments"
  DROP CONSTRAINT "review_assignments_claimed_revision_ck",
  ADD CONSTRAINT "review_assignments_claimed_revision_ck" CHECK (
    (
      "assignment_kind" = 'human'
      AND "claimed_problem_revision" IS NULL
      AND "claimed_submitted_revision_id" IS NULL
      AND "claimed_tag_catalog_version" IS NULL
    )
    OR
    (
      "assignment_kind" = 'robot'
      AND "claimed_problem_revision" IS NOT NULL
      AND "claimed_problem_revision" > 0
      AND "claimed_submitted_revision_id" IS NOT NULL
      AND (
        "claimed_tag_catalog_version" > 0
        OR (
          "claimed_tag_catalog_version" IS NULL
          AND "closure_reason" IS NOT NULL
        )
      )
      AND "expires_at" IS NOT NULL
    )
  );
