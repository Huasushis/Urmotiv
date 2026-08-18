ALTER TABLE "users" ADD COLUMN "qq" varchar(20);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "avatar_source" varchar(10) NOT NULL DEFAULT 'none';
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "avatar" bytea;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "avatar_media_type" varchar(40);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "avatar_updated_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_qq_format_ck" CHECK ("qq" IS NULL OR "qq" ~ '^[1-9][0-9]{4,10}$');
--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_avatar_source_ck" CHECK ("avatar_source" IN ('none', 'qq', 'uploaded'));
--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_avatar_source_bytes_ck" CHECK (
  ("avatar_source" = 'none' AND "avatar" IS NULL AND "avatar_media_type" IS NULL)
  OR ("avatar_source" = 'uploaded' AND "avatar" IS NOT NULL AND "avatar_media_type" IS NOT NULL)
  OR ("avatar_source" = 'qq' AND "avatar" IS NULL AND "avatar_media_type" IS NULL AND "qq" IS NOT NULL)
);
--> statement-breakpoint
CREATE INDEX "users_qq_idx" ON "users" ("qq") WHERE "qq" IS NOT NULL;