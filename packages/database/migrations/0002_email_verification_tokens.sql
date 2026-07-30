CREATE TABLE "email_verification_tokens" (
  "token_digest" char(64) PRIMARY KEY,
  "user_id" bigint NOT NULL REFERENCES "users" ("id") ON DELETE CASCADE,
  "normalized_address" varchar(320) NOT NULL,
  "expires_at" timestamptz NOT NULL,
  "consumed_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "email_verification_tokens_digest_ck" CHECK ("token_digest" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "email_verification_tokens_not_blank_ck" CHECK (length(btrim("normalized_address")) > 0)
);
--> statement-breakpoint
CREATE INDEX "email_verification_tokens_user_email_idx"
  ON "email_verification_tokens" ("user_id", "normalized_address");
--> statement-breakpoint
CREATE INDEX "email_verification_tokens_expiry_idx"
  ON "email_verification_tokens" ("expires_at");
