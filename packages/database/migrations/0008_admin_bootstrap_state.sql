CREATE TYPE "admin_bootstrap_status" AS ENUM ('blocked', 'open', 'completed');
--> statement-breakpoint
CREATE TABLE "admin_bootstrap_state" (
  "singleton" boolean PRIMARY KEY DEFAULT true,
  "status" "admin_bootstrap_status" NOT NULL DEFAULT 'blocked',
  "opened_at" timestamptz,
  "completed_at" timestamptz,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "admin_bootstrap_state_singleton_ck" CHECK ("singleton" = true),
  CONSTRAINT "admin_bootstrap_state_timestamps_ck" CHECK (
    ("status" = 'blocked' AND "opened_at" IS NULL AND "completed_at" IS NULL)
    OR
    ("status" = 'open' AND "opened_at" IS NOT NULL AND "completed_at" IS NULL)
    OR
    (
      "status" = 'completed'
      AND "opened_at" IS NOT NULL
      AND "completed_at" IS NOT NULL
      AND "completed_at" >= "opened_at"
    )
  )
);
--> statement-breakpoint
INSERT INTO "admin_bootstrap_state" ("singleton", "status")
VALUES (true, 'blocked');
--> statement-breakpoint
CREATE FUNCTION "protect_admin_bootstrap_state"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'admin_bootstrap_state cannot be truncated';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'admin_bootstrap_state cannot be deleted';
  END IF;

  IF OLD.status = 'completed' AND NEW.status <> 'completed' THEN
    RAISE EXCEPTION 'admin_bootstrap_state cannot leave completed';
  END IF;

  IF OLD.status = 'open' AND NEW.status = 'blocked' THEN
    RAISE EXCEPTION 'admin_bootstrap_state cannot return to blocked';
  END IF;

  IF OLD.opened_at IS NOT NULL AND NEW.opened_at IS DISTINCT FROM OLD.opened_at THEN
    RAISE EXCEPTION 'admin_bootstrap_state opened_at is immutable';
  END IF;

  IF OLD.completed_at IS NOT NULL AND NEW.completed_at IS DISTINCT FROM OLD.completed_at THEN
    RAISE EXCEPTION 'admin_bootstrap_state completed_at is immutable';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "admin_bootstrap_state_protect"
BEFORE UPDATE OR DELETE ON "admin_bootstrap_state"
FOR EACH ROW EXECUTE FUNCTION "protect_admin_bootstrap_state"();
--> statement-breakpoint
CREATE TRIGGER "admin_bootstrap_state_no_truncate"
BEFORE TRUNCATE ON "admin_bootstrap_state"
FOR EACH STATEMENT EXECUTE FUNCTION "protect_admin_bootstrap_state"();
