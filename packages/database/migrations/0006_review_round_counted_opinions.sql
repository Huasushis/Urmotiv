ALTER TABLE "review_rounds"
  ADD COLUMN "counted_opinion_ids" jsonb NOT NULL DEFAULT '[]'::jsonb;
--> statement-breakpoint
UPDATE "review_rounds"
SET "counted_opinion_ids" = "used_opinion_ids"
WHERE "status" <> 'open';
--> statement-breakpoint
ALTER TABLE "review_rounds"
  ADD CONSTRAINT "review_rounds_counted_opinions_ck"
    CHECK (jsonb_typeof("counted_opinion_ids") = 'array');
