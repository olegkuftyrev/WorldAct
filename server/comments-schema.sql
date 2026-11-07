ALTER TABLE comments ADD COLUMN IF NOT EXISTS author_url text NOT NULL DEFAULT '';
ALTER TABLE comments ADD COLUMN IF NOT EXISTS user_id integer REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE comments ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1;
ALTER TABLE comments ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
CREATE INDEX IF NOT EXISTS comments_email_lower ON comments(lower(author_email));
CREATE INDEX IF NOT EXISTS comments_user ON comments(user_id) WHERE user_id IS NOT NULL;
