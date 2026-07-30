ALTER TABLE "review_rounds"
  ADD COLUMN "rule_version" varchar(80) NOT NULL DEFAULT '1.0.0';
--> statement-breakpoint
ALTER TABLE "review_rounds"
  ALTER COLUMN "decision_reason" TYPE varchar(2000);
--> statement-breakpoint
ALTER TABLE "review_rounds"
  ADD COLUMN "used_opinion_ids" jsonb NOT NULL DEFAULT '[]'::jsonb;
--> statement-breakpoint
ALTER TABLE "review_rounds"
  ADD COLUMN "used_review_item_ids" jsonb NOT NULL DEFAULT '[]'::jsonb;
--> statement-breakpoint
ALTER TABLE "review_rounds"
  ADD COLUMN "decision_source" varchar(20);
--> statement-breakpoint
UPDATE "review_rounds"
SET "rule_settings" = jsonb_build_object(
  'requiredApprovals', 2,
  'maximumRejections', 0,
  'countRobotReviews', false
)
WHERE "rule_id" = 'org.ustc.urmotiv.review-default.count';
--> statement-breakpoint
UPDATE "review_rounds"
SET "decision_source" = CASE
  WHEN "status" = 'withdrawn' THEN 'withdrawal'
  ELSE 'rule'
END
WHERE "status" <> 'open';
--> statement-breakpoint
ALTER TABLE "review_rounds"
  ADD CONSTRAINT "review_rounds_used_opinions_ck"
    CHECK (jsonb_typeof("used_opinion_ids") = 'array');
--> statement-breakpoint
ALTER TABLE "review_rounds"
  ADD CONSTRAINT "review_rounds_used_items_ck"
    CHECK (jsonb_typeof("used_review_item_ids") = 'array');
--> statement-breakpoint
ALTER TABLE "review_rounds"
  ADD CONSTRAINT "review_rounds_decision_source_ck"
    CHECK (
      ("status" = 'open' AND "decision_source" IS NULL)
      OR
      ("status" <> 'open' AND "decision_source" IN ('rule', 'manual', 'withdrawal'))
    );
--> statement-breakpoint

CREATE TABLE "review_policy" (
  "singleton" boolean PRIMARY KEY DEFAULT true,
  "rule_id" varchar(160) NOT NULL,
  "rule_version" varchar(80) NOT NULL,
  "rule_settings" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "revision" integer NOT NULL DEFAULT 1,
  "updated_by_user_id" bigint REFERENCES "users" ("id") ON DELETE RESTRICT,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "review_policy_singleton_ck" CHECK ("singleton" = true),
  CONSTRAINT "review_policy_revision_ck" CHECK ("revision" > 0),
  CONSTRAINT "review_policy_settings_ck" CHECK (jsonb_typeof("rule_settings") = 'object')
);
--> statement-breakpoint
INSERT INTO "review_policy" (
  "singleton",
  "rule_id",
  "rule_version",
  "rule_settings",
  "revision"
) VALUES (
  true,
  'org.ustc.urmotiv.review-default.count',
  '1.0.0',
  '{"requiredApprovals":2,"maximumRejections":0,"countRobotReviews":false}'::jsonb,
  1
);
