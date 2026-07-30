CREATE TABLE "login_states" (
  "nonce_digest" char(64) PRIMARY KEY,
  "expires_at" timestamptz NOT NULL,
  "consumed_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "login_states_digest_ck" CHECK ("nonce_digest" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE INDEX "login_states_expiry_idx" ON "login_states" ("expires_at");
