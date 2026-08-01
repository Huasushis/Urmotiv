ALTER TABLE "review_opinions"
  ADD COLUMN "originality_level" smallint;
--> statement-breakpoint
ALTER TABLE "review_opinions"
  ADD CONSTRAINT "review_opinions_originality_level_ck"
    CHECK (
      "originality_level" IS NULL
      OR "originality_level" BETWEEN 1 AND 5
    );
