DO $$
BEGIN
  -- The legacy claim statement writes review_assignments before it reads its
  -- review_round.  New code uses the opposite problem -> round -> assignment
  -- order, so a blocking lock sequence cannot be safe for both versions.
  -- Require a drained maintenance window instead: take every relation touched
  -- by the migration with NOWAIT, starting with the legacy write target.  A
  -- failed multi-relation LOCK is rolled back with the migration transaction;
  -- after success, ACCESS EXCLUSIVE also prevents a legacy writer from entering
  -- while the gate and schema changes run.
  BEGIN
    LOCK TABLE
      "review_assignments",
      "review_rounds",
      "users",
      "problem_revisions",
      "audit_events",
      "review_opinions"
    IN ACCESS EXCLUSIVE MODE NOWAIT;
  EXCEPTION
    WHEN lock_not_available THEN
      RAISE EXCEPTION USING
        ERRCODE = '55006',
        MESSAGE = 'robot review lease migration requires the API to be stopped and database transactions to be drained';
  END;

  IF EXISTS (
    SELECT 1
    FROM review_assignments assignment
    JOIN users reviewer ON reviewer.id = assignment.reviewer_user_id
    WHERE reviewer.account_type = 'robot'
      AND assignment.revoked_at IS NULL
      AND (assignment.expires_at IS NULL OR assignment.expires_at > now())
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '55006',
      MESSAGE = 'robot review lease migration requires all live robot leases to finish';
  END IF;
END;
$$;
--> statement-breakpoint
CREATE TYPE "review_assignment_kind" AS ENUM ('human', 'robot');
--> statement-breakpoint
CREATE TYPE "review_assignment_closure_reason" AS ENUM (
  'completed',
  'expired',
  'round_closed',
  'permission_revoked',
  'content_changed',
  'abandoned',
  'legacy_closed'
);
--> statement-breakpoint
CREATE TYPE "review_assignment_operation" AS ENUM ('renew', 'complete');
--> statement-breakpoint
CREATE UNIQUE INDEX "review_rounds_id_submitted_revision_uq"
  ON "review_rounds" ("id", "submitted_revision_id");
--> statement-breakpoint
ALTER TABLE "review_assignments"
  ADD COLUMN "assignment_kind" "review_assignment_kind" NOT NULL DEFAULT 'human',
  ADD COLUMN "claimed_problem_revision" integer,
  ADD COLUMN "claimed_submitted_revision_id" uuid,
  ADD COLUMN "closed_at" timestamptz,
  ADD COLUMN "closure_reason" "review_assignment_closure_reason",
  ADD COLUMN "closed_by_user_id" bigint REFERENCES "users" ("id") ON DELETE RESTRICT,
  ADD COLUMN "last_renewal_request_id" uuid,
  ADD COLUMN "last_renewal_payload_digest" char(64),
  ADD COLUMN "last_renewal_result" jsonb,
  ADD COLUMN "last_renewal_audit_id" bigint REFERENCES "audit_events" ("id") ON DELETE RESTRICT,
  ADD COLUMN "completion_request_id" uuid,
  ADD COLUMN "completion_payload_digest" char(64),
  ADD COLUMN "completion_result" jsonb,
  ADD COLUMN "completion_audit_id" bigint REFERENCES "audit_events" ("id") ON DELETE RESTRICT,
  ADD COLUMN "completion_opinion_id" uuid REFERENCES "review_opinions" ("id") ON DELETE RESTRICT;
--> statement-breakpoint
UPDATE "review_assignments" assignment
SET "assignment_kind" = 'robot',
    "claimed_problem_revision" = submitted_revision.revision,
    "claimed_submitted_revision_id" = review_round.submitted_revision_id,
    "expires_at" = CASE
      WHEN assignment.revoked_at IS NOT NULL AND assignment.expires_at IS NULL
        THEN GREATEST(assignment.revoked_at, assignment.created_at + interval '1 microsecond')
      ELSE assignment.expires_at
    END
FROM "users" reviewer,
     "review_rounds" review_round,
     "problem_revisions" submitted_revision
WHERE reviewer.id = assignment.reviewer_user_id
  AND reviewer.account_type = 'robot'
  AND review_round.id = assignment.round_id
  AND submitted_revision.id = review_round.submitted_revision_id;
--> statement-breakpoint
UPDATE "review_assignments"
SET "closed_at" = "revoked_at",
    "closure_reason" = 'legacy_closed',
    "closed_by_user_id" = "revoked_by_user_id"
WHERE "revoked_at" IS NOT NULL;
--> statement-breakpoint
UPDATE "review_assignments"
SET "closed_at" = now(),
    "closure_reason" = 'expired',
    "closed_by_user_id" = "reviewer_user_id",
    "revoked_at" = now(),
    "revoked_by_user_id" = "reviewer_user_id"
WHERE "assignment_kind" = 'robot'
  AND "revoked_at" IS NULL
  AND "expires_at" <= now();
--> statement-breakpoint
ALTER TABLE "review_assignments"
  ALTER COLUMN "assignment_kind" DROP DEFAULT,
  ADD CONSTRAINT "review_assignments_claimed_revision_ck" CHECK (
    (
      "assignment_kind" = 'human'
      AND "claimed_problem_revision" IS NULL
      AND "claimed_submitted_revision_id" IS NULL
    )
    OR
    (
      "assignment_kind" = 'robot'
      AND "claimed_problem_revision" IS NOT NULL
      AND "claimed_problem_revision" > 0
      AND "claimed_submitted_revision_id" IS NOT NULL
      AND "expires_at" IS NOT NULL
    )
  ),
  ADD CONSTRAINT "review_assignments_lifecycle_ck" CHECK (
    (
      "closure_reason" IS NULL
      AND "closed_at" IS NULL
      AND "closed_by_user_id" IS NULL
      AND "revoked_at" IS NULL
      AND "revoked_by_user_id" IS NULL
    )
    OR
    (
      "closure_reason" IS NOT NULL
      AND "closed_at" IS NOT NULL
      AND "closed_by_user_id" IS NOT NULL
      AND "revoked_at" = "closed_at"
      AND "revoked_by_user_id" = "closed_by_user_id"
    )
  ),
  ADD CONSTRAINT "review_assignments_last_renewal_ck" CHECK (
    num_nonnulls(
      "last_renewal_request_id",
      "last_renewal_payload_digest",
      "last_renewal_result",
      "last_renewal_audit_id"
    ) IN (0, 4)
    AND (
      "last_renewal_payload_digest" IS NULL
      OR "last_renewal_payload_digest" ~ '^[0-9a-f]{64}$'
    )
    AND (
      "last_renewal_result" IS NULL
      OR jsonb_typeof("last_renewal_result") = 'object'
    )
  ),
  ADD CONSTRAINT "review_assignments_completion_ck" CHECK (
    (
      "closure_reason" = 'completed'
      AND num_nonnulls(
        "completion_request_id",
        "completion_payload_digest",
        "completion_result",
        "completion_audit_id",
        "completion_opinion_id"
      ) = 5
    )
    OR
    (
      "closure_reason" IS DISTINCT FROM 'completed'
      AND num_nonnulls(
        "completion_request_id",
        "completion_payload_digest",
        "completion_result",
        "completion_audit_id",
        "completion_opinion_id"
      ) = 0
    )
  ),
  ADD CONSTRAINT "review_assignments_completion_digest_ck" CHECK (
    "completion_payload_digest" IS NULL
    OR "completion_payload_digest" ~ '^[0-9a-f]{64}$'
  ),
  ADD CONSTRAINT "review_assignments_completion_result_ck" CHECK (
    "completion_result" IS NULL
    OR jsonb_typeof("completion_result") = 'object'
  ),
  ADD CONSTRAINT "review_assignments_claimed_round_fk"
    FOREIGN KEY ("round_id", "claimed_submitted_revision_id")
    REFERENCES "review_rounds" ("id", "submitted_revision_id") ON DELETE RESTRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX "review_assignments_completion_request_uq"
  ON "review_assignments" ("id", "completion_request_id")
  WHERE "completion_request_id" IS NOT NULL;
--> statement-breakpoint
CREATE TABLE "review_assignment_operations" (
  "assignment_id" uuid NOT NULL REFERENCES "review_assignments" ("id") ON DELETE RESTRICT,
  "request_id" uuid NOT NULL,
  "operation" "review_assignment_operation" NOT NULL,
  "payload_digest" char(64) NOT NULL,
  "result" jsonb NOT NULL,
  "audit_event_id" bigint NOT NULL REFERENCES "audit_events" ("id") ON DELETE RESTRICT,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "review_assignment_operations_pk" PRIMARY KEY ("assignment_id", "request_id"),
  CONSTRAINT "review_assignment_operations_digest_ck"
    CHECK ("payload_digest" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "review_assignment_operations_result_ck"
    CHECK (jsonb_typeof("result") = 'object')
);
--> statement-breakpoint
CREATE INDEX "review_assignment_operations_audit_idx"
  ON "review_assignment_operations" ("audit_event_id");
