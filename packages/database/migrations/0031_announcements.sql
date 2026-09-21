CREATE TABLE announcements (
  id uuid PRIMARY KEY,
  title text NOT NULL CHECK(length(title) BETWEEN 1 AND 160),
  body text NOT NULL CHECK(length(body) BETWEEN 1 AND 30000),
  audience text NOT NULL CHECK(audience IN ('all','newcomers','roles')),
  role_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  newcomer_days integer NOT NULL DEFAULT 30 CHECK(newcomer_days BETWEEN 1 AND 365),
  pinned boolean NOT NULL DEFAULT false,
  popup boolean NOT NULL DEFAULT true,
  published boolean NOT NULL DEFAULT false,
  revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
  created_by_user_id bigint NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX announcements_feed_idx ON announcements(published,pinned,updated_at DESC);
--> statement-breakpoint
CREATE TABLE announcement_reads (
  announcement_id uuid NOT NULL REFERENCES announcements(id) ON DELETE CASCADE,
  user_id bigint NOT NULL REFERENCES users(id),
  revision integer NOT NULL CHECK(revision>0),
  read_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(announcement_id,user_id)
);
