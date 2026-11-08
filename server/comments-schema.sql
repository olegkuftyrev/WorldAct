ALTER TABLE comments ADD COLUMN IF NOT EXISTS author_url text NOT NULL DEFAULT '';
ALTER TABLE comments ADD COLUMN IF NOT EXISTS user_id integer REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE comments ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1;
ALTER TABLE comments ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE comments ADD COLUMN IF NOT EXISTS previous_status varchar(10) CHECK (previous_status IN ('approved','pending','spam','trash'));
ALTER TABLE comments ADD COLUMN IF NOT EXISTS trashed_at timestamptz;
CREATE INDEX IF NOT EXISTS comments_email_lower ON comments(lower(author_email));
CREATE INDEX IF NOT EXISTS comments_user ON comments(user_id) WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS comments_post_status ON comments(post_id,status);

-- Private anti-flood IPs expire after one hour; existing content is not backfilled.
-- Keep these outside comments, whose ordinary site archive exports all columns.
CREATE TABLE IF NOT EXISTS comment_flood_metadata (
  comment_id integer PRIMARY KEY REFERENCES comments(id) ON DELETE CASCADE,
  author_ip varchar(64) NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS comment_flood_metadata_ip ON comment_flood_metadata(author_ip,comment_id);
CREATE INDEX IF NOT EXISTS comment_flood_metadata_expiry ON comment_flood_metadata(expires_at);
