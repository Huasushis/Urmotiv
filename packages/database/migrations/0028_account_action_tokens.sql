CREATE TABLE account_action_tokens (
  token_digest char(64) PRIMARY KEY CHECK (token_digest ~ '^[0-9a-f]{64}$'),
  user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose varchar(32) NOT NULL CHECK (purpose IN ('password-reset', 'email-change')),
  auth_revision integer NOT NULL CHECK (auth_revision > 0),
  normalized_address varchar(320) NOT NULL CHECK (normalized_address = lower(btrim(normalized_address)) AND length(normalized_address) > 0),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, purpose)
);
--> statement-breakpoint
CREATE INDEX account_action_tokens_expiry_idx ON account_action_tokens(expires_at);
