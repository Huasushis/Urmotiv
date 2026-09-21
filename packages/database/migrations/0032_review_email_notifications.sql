CREATE TABLE email_notification_preferences (
  user_id bigint PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  new_review boolean NOT NULL DEFAULT true,
  approved boolean NOT NULL DEFAULT true,
  rejected boolean NOT NULL DEFAULT true
);
--> statement-breakpoint
CREATE TABLE review_email_outbox (
  id uuid PRIMARY KEY,
  event_key text NOT NULL UNIQUE,
  user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  problem_id bigint NOT NULL REFERENCES problems(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('newReview','approved','rejected')),
  attempts integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  outcome text CHECK (outcome IN ('sent','skipped','failed'))
);
--> statement-breakpoint
CREATE INDEX review_email_pending_idx ON review_email_outbox(available_at) WHERE completed_at IS NULL;
