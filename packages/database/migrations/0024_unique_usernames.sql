UPDATE "users"
SET "username" = 'root'
WHERE "id" = 0
  AND "username" IS DISTINCT FROM 'root';
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "users"
    WHERE "username" IS NOT NULL
    GROUP BY lower(btrim("username"))
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'cannot enforce unique usernames while normalized duplicates exist';
  END IF;
END
$$;
--> statement-breakpoint
CREATE UNIQUE INDEX "users_username_normalized_uq"
ON "users" (lower(btrim("username")))
WHERE "username" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "users"
ADD CONSTRAINT "users_root_username_ck"
CHECK ("id" <> 0 OR "username" = 'root');
