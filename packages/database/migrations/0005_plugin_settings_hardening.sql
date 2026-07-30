ALTER TYPE "plugin_state" RENAME VALUE 'unavailable' TO 'failed';
--> statement-breakpoint
ALTER TABLE "plugin_secrets" ADD COLUMN "value_length" integer;
--> statement-breakpoint
ALTER TABLE "plugin_secrets" ADD CONSTRAINT "plugin_secrets_value_length_ck"
  CHECK ("value_length" IS NULL OR "value_length" > 0);
