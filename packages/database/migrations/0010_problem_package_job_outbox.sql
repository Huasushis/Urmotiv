CREATE TYPE "problem_package_job_kind" AS ENUM ('import', 'export');
--> statement-breakpoint
CREATE TABLE "problem_package_job_outbox" (
  "job_id" uuid PRIMARY KEY,
  "job_kind" "problem_package_job_kind" NOT NULL,
  "import_job_id" uuid,
  "export_job_id" uuid,
  "delivery_generation" integer NOT NULL DEFAULT 1,
  "max_delivery_generations" smallint NOT NULL DEFAULT 3,
  "queue_job_id" uuid NOT NULL,
  "queue_job_ids" uuid[] NOT NULL,
  "queue_idempotency_scope" varchar(200) NOT NULL,
  "queue_idempotency_key" varchar(200) NOT NULL,
  "queue_request_digest" char(64) NOT NULL,
  "max_attempts" smallint NOT NULL,
  "timeout_ms" integer NOT NULL,
  "next_dispatch_at" timestamptz,
  "dispatch_attempts" integer NOT NULL DEFAULT 0,
  "dispatch_claim_id" uuid,
  "dispatch_claimed_by" varchar(200),
  "dispatch_claimed_at" timestamptz,
  "dispatch_claim_expires_at" timestamptz,
  "dispatch_claim_generation" integer,
  "dispatch_claim_queue_job_id" uuid,
  "last_dispatched_at" timestamptz,
  "last_dispatch_error_code" varchar(120),
  "execution_fence" bigint NOT NULL DEFAULT 0,
  "execution_delivery_generation" integer,
  "execution_queue_job_id" uuid,
  "execution_queue_lease_id" uuid,
  "execution_worker_id" varchar(200),
  "execution_queue_attempt" smallint,
  "execution_claimed_at" timestamptz,
  "execution_lease_expires_at" timestamptz,
  "retired_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "problem_package_job_outbox_parent_ck" CHECK (
    (
      "job_kind" = 'import'
      AND "import_job_id" = "job_id"
      AND "export_job_id" IS NULL
      AND "queue_idempotency_scope" = 'problem-package-import'
    )
    OR
    (
      "job_kind" = 'export'
      AND "export_job_id" = "job_id"
      AND "import_job_id" IS NULL
      AND "queue_idempotency_scope" = 'problem-package-export'
    )
  ),
  CONSTRAINT "problem_package_job_outbox_queue_identity_ck" CHECK (
    "delivery_generation" BETWEEN 1 AND "max_delivery_generations"
    AND "max_delivery_generations" BETWEEN 1 AND 20
    AND "queue_job_id" <> "job_id"
    AND array_ndims("queue_job_ids") = 1
    AND array_lower("queue_job_ids", 1) = 1
    AND array_upper("queue_job_ids", 1) = "delivery_generation"
    AND "queue_job_ids"["delivery_generation"] = "queue_job_id"
    AND array_position("queue_job_ids", NULL) IS NULL
    AND "queue_idempotency_key" = "queue_job_id"::text
    AND "queue_request_digest" ~ '^[0-9a-f]{64}$'
    AND "max_attempts" BETWEEN 1 AND 20
    AND "timeout_ms" BETWEEN 100 AND 86400000
  ),
  CONSTRAINT "problem_package_job_outbox_dispatch_ck" CHECK (
    "dispatch_attempts" >= 0
    AND num_nonnulls(
      "dispatch_claim_id",
      "dispatch_claimed_by",
      "dispatch_claimed_at",
      "dispatch_claim_expires_at",
      "dispatch_claim_generation",
      "dispatch_claim_queue_job_id"
    ) IN (0, 6)
    AND (
      "dispatch_claim_id" IS NULL
      OR (
        "dispatch_attempts" > 0
        AND "dispatch_claim_generation" = "delivery_generation"
        AND "dispatch_claim_queue_job_id" = "queue_job_id"
        AND "dispatch_claim_expires_at" > "dispatch_claimed_at"
        AND length(btrim("dispatch_claimed_by")) > 0
        AND "dispatch_claimed_by" !~ '[[:cntrl:]]'
      )
    )
    AND (
      "last_dispatch_error_code" IS NULL
      OR "last_dispatch_error_code" ~ '^[a-z0-9]+(?:[._-][a-z0-9]+)*$'
    )
  ),
  CONSTRAINT "problem_package_job_outbox_execution_ck" CHECK (
    "execution_fence" >= 0
    AND (
      num_nonnulls(
        "execution_delivery_generation",
        "execution_queue_job_id",
        "execution_queue_lease_id",
        "execution_worker_id",
        "execution_queue_attempt",
        "execution_claimed_at",
        "execution_lease_expires_at"
      ) = 0
      OR (
        "execution_fence" > 0
        AND "last_dispatched_at" IS NOT NULL
        AND "next_dispatch_at" IS NULL
        AND num_nonnulls(
          "execution_delivery_generation",
          "execution_queue_job_id",
          "execution_queue_lease_id",
          "execution_worker_id",
          "execution_queue_attempt",
          "execution_claimed_at",
          "execution_lease_expires_at"
        ) = 7
        AND "execution_delivery_generation" = "delivery_generation"
        AND "execution_queue_job_id" = "queue_job_id"
        AND "execution_queue_attempt" BETWEEN 1 AND 20
        AND "execution_queue_attempt" <= "max_attempts"
        AND "execution_lease_expires_at" > "execution_claimed_at"
        AND length(btrim("execution_worker_id")) > 0
        AND "execution_worker_id" !~ '[[:cntrl:]]'
      )
    )
  ),
  CONSTRAINT "problem_package_job_outbox_lifecycle_ck" CHECK (
    "retired_at" IS NULL
    OR (
      "next_dispatch_at" IS NULL
      AND num_nonnulls(
        "dispatch_claim_id",
        "dispatch_claimed_by",
        "dispatch_claimed_at",
        "dispatch_claim_expires_at",
        "dispatch_claim_generation",
        "dispatch_claim_queue_job_id"
      ) = 0
      AND num_nonnulls(
        "execution_delivery_generation",
        "execution_queue_job_id",
        "execution_queue_lease_id",
        "execution_worker_id",
        "execution_queue_attempt",
        "execution_claimed_at",
        "execution_lease_expires_at"
      ) = 0
    )
  ),
  CONSTRAINT "problem_package_job_outbox_timestamps_ck" CHECK (
    "updated_at" >= "created_at"
    AND ("next_dispatch_at" IS NULL OR "next_dispatch_at" >= "created_at")
    AND ("last_dispatched_at" IS NULL OR "last_dispatched_at" >= "created_at")
    AND ("retired_at" IS NULL OR "retired_at" >= "created_at")
  )
);
--> statement-breakpoint
CREATE UNIQUE INDEX "problem_package_job_outbox_import_uq"
  ON "problem_package_job_outbox" ("import_job_id")
  WHERE "import_job_id" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "problem_package_job_outbox_export_uq"
  ON "problem_package_job_outbox" ("export_job_id")
  WHERE "export_job_id" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "problem_package_job_outbox_queue_job_uq"
  ON "problem_package_job_outbox" ("queue_job_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "problem_package_job_outbox_queue_identity_uq"
  ON "problem_package_job_outbox" (
    "queue_idempotency_scope",
    "queue_idempotency_key"
  );
--> statement-breakpoint
CREATE INDEX "problem_package_job_outbox_ready_idx"
  ON "problem_package_job_outbox" (
    "next_dispatch_at",
    "dispatch_claim_expires_at",
    "created_at",
    "job_id"
  )
  WHERE "retired_at" IS NULL AND "next_dispatch_at" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "problem_package_job_outbox_execution_expiry_idx"
  ON "problem_package_job_outbox" (
    "execution_lease_expires_at",
    "execution_delivery_generation",
    "execution_queue_job_id",
    "job_id"
  )
  WHERE "retired_at" IS NULL AND "execution_queue_lease_id" IS NOT NULL;
--> statement-breakpoint
CREATE FUNCTION "protect_problem_package_job_outbox"()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  old_has_dispatch_claim boolean;
  new_has_dispatch_claim boolean;
  old_has_execution boolean;
  new_has_execution boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'PP_JOB_OUTBOX_DELETE_FORBIDDEN';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF (
      (
        NEW."job_kind" = 'import'
        AND NEW."import_job_id" = NEW."job_id"
        AND NEW."export_job_id" IS NULL
        AND NEW."queue_idempotency_scope" = 'problem-package-import'
      )
      OR
      (
        NEW."job_kind" = 'export'
        AND NEW."export_job_id" = NEW."job_id"
        AND NEW."import_job_id" IS NULL
        AND NEW."queue_idempotency_scope" = 'problem-package-export'
      )
    ) IS NOT TRUE THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'PP_JOB_OUTBOX_PARENT_INVALID';
    END IF;
    IF NEW."delivery_generation" <> 1
      OR NEW."queue_job_ids" IS DISTINCT FROM ARRAY[NEW."queue_job_id"]
      OR NEW."dispatch_attempts" <> 0
      OR NEW."dispatch_claim_id" IS NOT NULL
      OR NEW."last_dispatched_at" IS NOT NULL
      OR NEW."last_dispatch_error_code" IS NOT NULL
      OR NEW."execution_fence" <> 0
      OR NEW."execution_queue_lease_id" IS NOT NULL
      OR NEW."retired_at" IS NOT NULL
      OR NEW."next_dispatch_at" IS NULL THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'PP_JOB_OUTBOX_INITIAL_STATE_INVALID';
    END IF;
    IF pg_catalog.current_setting('transaction_isolation') <> 'read committed' THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'PP_JOB_OUTBOX_IDENTITY_ISOLATION_UNSUPPORTED';
    END IF;
    PERFORM pg_catalog.pg_advisory_xact_lock(1431453002, 1651666805);
    IF EXISTS (
      SELECT 1
      FROM public."problem_package_job_outbox" existing
      WHERE NEW."queue_job_id" = ANY(existing."queue_job_ids")
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'PP_JOB_OUTBOX_DELIVERY_IDENTITY_GLOBALLY_REUSED';
    END IF;
    RETURN NEW;
  END IF;

  old_has_dispatch_claim := OLD."dispatch_claim_id" IS NOT NULL;
  new_has_dispatch_claim := NEW."dispatch_claim_id" IS NOT NULL;
  old_has_execution := OLD."execution_queue_lease_id" IS NOT NULL;
  new_has_execution := NEW."execution_queue_lease_id" IS NOT NULL;

  IF ROW(
    NEW."job_id",
    NEW."job_kind",
    NEW."import_job_id",
    NEW."export_job_id",
    NEW."queue_idempotency_scope",
    NEW."queue_request_digest",
    NEW."max_attempts",
    NEW."timeout_ms",
    NEW."max_delivery_generations",
    NEW."created_at"
  ) IS DISTINCT FROM ROW(
    OLD."job_id",
    OLD."job_kind",
    OLD."import_job_id",
    OLD."export_job_id",
    OLD."queue_idempotency_scope",
    OLD."queue_request_digest",
    OLD."max_attempts",
    OLD."timeout_ms",
    OLD."max_delivery_generations",
    OLD."created_at"
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'PP_JOB_OUTBOX_IDENTITY_IMMUTABLE';
  END IF;

  IF OLD."retired_at" IS NOT NULL THEN
    IF NEW IS DISTINCT FROM OLD THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'PP_JOB_OUTBOX_RETIREMENT_IMMUTABLE';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW."retired_at" IS NOT NULL THEN
    IF old_has_dispatch_claim
      AND OLD."dispatch_claim_expires_at" > clock_timestamp() THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'PP_JOB_OUTBOX_RETIREMENT_DISPATCH_ACTIVE';
    END IF;
    IF new_has_dispatch_claim THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'PP_JOB_OUTBOX_RETIREMENT_DISPATCH_IDENTITY';
    END IF;
    IF old_has_execution
      AND OLD."execution_lease_expires_at" > clock_timestamp() THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'PP_JOB_OUTBOX_RETIREMENT_EXECUTION_ACTIVE';
    END IF;
    IF new_has_execution THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'PP_JOB_OUTBOX_RETIREMENT_EXECUTION_IDENTITY';
    END IF;
  END IF;

  IF NEW."delivery_generation" < OLD."delivery_generation" THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'PP_JOB_OUTBOX_DELIVERY_REGRESSION';
  ELSIF NEW."delivery_generation" > OLD."delivery_generation" THEN
    IF NEW."delivery_generation" <> OLD."delivery_generation" + 1 THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'PP_JOB_OUTBOX_DELIVERY_STEP';
    END IF;
    IF NEW."delivery_generation" > OLD."max_delivery_generations" THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'PP_JOB_OUTBOX_DELIVERY_LIMIT';
    END IF;
    IF OLD."retired_at" IS NOT NULL OR NEW."retired_at" IS NOT NULL THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'PP_JOB_OUTBOX_DELIVERY_RETIRED';
    END IF;
    IF OLD."last_dispatched_at" IS NULL THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'PP_JOB_OUTBOX_DELIVERY_NOT_DISPATCHED';
    END IF;
    IF old_has_dispatch_claim OR new_has_dispatch_claim THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'PP_JOB_OUTBOX_DELIVERY_DISPATCH_ACTIVE';
    END IF;
    IF old_has_execution
      AND OLD."execution_lease_expires_at" > clock_timestamp() THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'PP_JOB_OUTBOX_FENCE_ACTIVE';
    END IF;
    IF NEW."queue_job_id" IS NOT DISTINCT FROM OLD."queue_job_id"
      OR NEW."queue_idempotency_key" IS NOT DISTINCT FROM OLD."queue_idempotency_key" THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'PP_JOB_OUTBOX_DELIVERY_IDENTITY';
    END IF;
    IF NEW."queue_job_id" = ANY(OLD."queue_job_ids") THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'PP_JOB_OUTBOX_DELIVERY_IDENTITY_REUSED';
    END IF;
    IF NEW."queue_job_ids" IS DISTINCT FROM
      array_append(OLD."queue_job_ids", NEW."queue_job_id") THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'PP_JOB_OUTBOX_DELIVERY_HISTORY_INVALID';
    END IF;
    IF NEW."next_dispatch_at" IS NULL
      OR NEW."dispatch_attempts" <> 0
      OR NEW."last_dispatched_at" IS NOT NULL
      OR NEW."last_dispatch_error_code" IS NOT NULL
      OR NEW."execution_fence" <> OLD."execution_fence"
      OR new_has_execution THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'PP_JOB_OUTBOX_DELIVERY_RESET_INVALID';
    END IF;
    IF pg_catalog.current_setting('transaction_isolation') <> 'read committed' THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'PP_JOB_OUTBOX_IDENTITY_ISOLATION_UNSUPPORTED';
    END IF;
    PERFORM pg_catalog.pg_advisory_xact_lock(1431453002, 1651666805);
    IF EXISTS (
      SELECT 1
      FROM public."problem_package_job_outbox" existing
      WHERE NEW."queue_job_id" = ANY(existing."queue_job_ids")
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'PP_JOB_OUTBOX_DELIVERY_IDENTITY_GLOBALLY_REUSED';
    END IF;
  ELSE
    IF NEW."queue_job_ids" IS DISTINCT FROM OLD."queue_job_ids" THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'PP_JOB_OUTBOX_DELIVERY_HISTORY_IMMUTABLE';
    END IF;
    IF ROW(
      NEW."queue_job_id",
      NEW."queue_idempotency_key"
    ) IS DISTINCT FROM ROW(
      OLD."queue_job_id",
      OLD."queue_idempotency_key"
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'PP_JOB_OUTBOX_DELIVERY_IDENTITY';
    END IF;

    IF NEW."last_dispatched_at" IS DISTINCT FROM OLD."last_dispatched_at"
      AND NOT (
        OLD."last_dispatched_at" IS NULL
        AND NEW."last_dispatched_at" IS NOT NULL
        AND old_has_dispatch_claim
        AND NOT new_has_dispatch_claim
      ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'PP_JOB_OUTBOX_DISPATCH_EVIDENCE';
    END IF;

    IF NEW."dispatch_attempts" < OLD."dispatch_attempts" THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'PP_JOB_OUTBOX_DISPATCH_REGRESSION';
    END IF;
    IF NOT old_has_dispatch_claim AND new_has_dispatch_claim THEN
      IF NEW."dispatch_attempts" <> OLD."dispatch_attempts" + 1 THEN
        RAISE EXCEPTION USING
          ERRCODE = '23514',
          MESSAGE = 'PP_JOB_OUTBOX_DISPATCH_STEP';
      END IF;
    ELSIF old_has_dispatch_claim AND new_has_dispatch_claim THEN
      IF NEW."dispatch_claim_id" IS NOT DISTINCT FROM OLD."dispatch_claim_id" THEN
        IF ROW(
          NEW."dispatch_claimed_by",
          NEW."dispatch_claimed_at",
          NEW."dispatch_claim_generation",
          NEW."dispatch_claim_queue_job_id",
          NEW."dispatch_attempts"
        ) IS DISTINCT FROM ROW(
          OLD."dispatch_claimed_by",
          OLD."dispatch_claimed_at",
          OLD."dispatch_claim_generation",
          OLD."dispatch_claim_queue_job_id",
          OLD."dispatch_attempts"
        ) THEN
          RAISE EXCEPTION USING
            ERRCODE = '23514',
            MESSAGE = 'PP_JOB_OUTBOX_DISPATCH_REUSE';
        END IF;
        IF NEW."dispatch_claim_expires_at" > OLD."dispatch_claim_expires_at"
          AND OLD."dispatch_claim_expires_at" <= clock_timestamp() THEN
          RAISE EXCEPTION USING
            ERRCODE = '23514',
            MESSAGE = 'PP_JOB_OUTBOX_DISPATCH_EXPIRED';
        END IF;
      ELSE
        IF OLD."dispatch_claim_expires_at" > clock_timestamp() THEN
          RAISE EXCEPTION USING
            ERRCODE = '23514',
            MESSAGE = 'PP_JOB_OUTBOX_DISPATCH_ACTIVE';
        END IF;
        IF NEW."dispatch_attempts" <> OLD."dispatch_attempts" + 1 THEN
          RAISE EXCEPTION USING
            ERRCODE = '23514',
            MESSAGE = 'PP_JOB_OUTBOX_DISPATCH_STEP';
        END IF;
      END IF;
    ELSIF NEW."dispatch_attempts" <> OLD."dispatch_attempts" THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'PP_JOB_OUTBOX_DISPATCH_STEP';
    END IF;
  END IF;

  IF NEW."execution_fence" < OLD."execution_fence" THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'PP_JOB_OUTBOX_FENCE_REGRESSION';
  ELSIF NEW."execution_fence" > OLD."execution_fence" THEN
    IF NEW."execution_fence" <> OLD."execution_fence" + 1 THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'PP_JOB_OUTBOX_FENCE_STEP';
    END IF;
    IF OLD."retired_at" IS NOT NULL OR NEW."retired_at" IS NOT NULL THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'PP_JOB_OUTBOX_FENCE_RETIRED';
    END IF;
    IF NOT new_has_execution THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'PP_JOB_OUTBOX_FENCE_IDENTITY';
    END IF;
    IF NEW."last_dispatched_at" IS NULL
      OR NEW."next_dispatch_at" IS NOT NULL THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'PP_JOB_OUTBOX_EXECUTION_NOT_DISPATCHED';
    END IF;
    IF old_has_execution THEN
      IF OLD."execution_lease_expires_at" > clock_timestamp() THEN
        RAISE EXCEPTION USING
          ERRCODE = '23514',
          MESSAGE = 'PP_JOB_OUTBOX_FENCE_ACTIVE';
      END IF;
      IF NEW."execution_queue_lease_id" IS NOT DISTINCT FROM OLD."execution_queue_lease_id" THEN
        RAISE EXCEPTION USING
          ERRCODE = '23514',
          MESSAGE = 'PP_JOB_OUTBOX_FENCE_IDENTITY';
      END IF;
      IF NEW."execution_delivery_generation" = OLD."execution_delivery_generation"
        AND NEW."execution_queue_attempt" <= OLD."execution_queue_attempt" THEN
        RAISE EXCEPTION USING
          ERRCODE = '23514',
          MESSAGE = 'PP_JOB_OUTBOX_FENCE_IDENTITY';
      END IF;
    END IF;
  ELSE
    IF NOT old_has_execution AND new_has_execution THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'PP_JOB_OUTBOX_FENCE_REQUIRED';
    ELSIF old_has_execution AND new_has_execution THEN
      IF ROW(
        NEW."execution_delivery_generation",
        NEW."execution_queue_job_id",
        NEW."execution_queue_lease_id",
        NEW."execution_worker_id",
        NEW."execution_queue_attempt",
        NEW."execution_claimed_at"
      ) IS DISTINCT FROM ROW(
        OLD."execution_delivery_generation",
        OLD."execution_queue_job_id",
        OLD."execution_queue_lease_id",
        OLD."execution_worker_id",
        OLD."execution_queue_attempt",
        OLD."execution_claimed_at"
      ) THEN
        RAISE EXCEPTION USING
          ERRCODE = '23514',
          MESSAGE = 'PP_JOB_OUTBOX_FENCE_REUSE';
      END IF;
      IF NEW."execution_lease_expires_at" > OLD."execution_lease_expires_at"
        AND OLD."execution_lease_expires_at" <= clock_timestamp() THEN
        RAISE EXCEPTION USING
          ERRCODE = '23514',
          MESSAGE = 'PP_JOB_OUTBOX_FENCE_EXPIRED';
      END IF;
    ELSIF old_has_execution
      AND NEW."retired_at" IS NULL
      AND OLD."execution_lease_expires_at" > clock_timestamp() THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'PP_JOB_OUTBOX_FENCE_ACTIVE';
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;
--> statement-breakpoint
CREATE TRIGGER "problem_package_job_outbox_protect_tr"
  BEFORE INSERT OR UPDATE OR DELETE ON "problem_package_job_outbox"
  FOR EACH ROW
  EXECUTE FUNCTION "protect_problem_package_job_outbox"();
--> statement-breakpoint
CREATE FUNCTION "reject_problem_package_job_outbox_truncate"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  RAISE EXCEPTION USING
    ERRCODE = '23514',
    MESSAGE = 'PP_JOB_OUTBOX_TRUNCATE_FORBIDDEN';
END;
$function$;
--> statement-breakpoint
CREATE TRIGGER "problem_package_job_outbox_truncate_tr"
  BEFORE TRUNCATE ON "problem_package_job_outbox"
  FOR EACH STATEMENT
  EXECUTE FUNCTION "reject_problem_package_job_outbox_truncate"();
