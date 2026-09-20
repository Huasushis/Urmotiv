ALTER TABLE users ADD COLUMN deleted_at timestamptz;
--> statement-breakpoint
ALTER TABLE users ADD CONSTRAINT users_deleted_state_ck
  CHECK (deleted_at IS NULL OR (id <> 0 AND disabled_at IS NOT NULL));
