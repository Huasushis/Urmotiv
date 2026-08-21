ALTER TABLE "users" ADD COLUMN "username" varchar(255);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "real_name" varchar(120);
--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_username_not_blank_ck" CHECK ("username" IS NULL OR length(btrim("username")) > 0);
--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_real_name_not_blank_ck" CHECK ("real_name" IS NULL OR length(btrim("real_name")) > 0);
