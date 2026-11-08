CREATE TABLE IF NOT EXISTS post_edit_locks (
  post_id integer PRIMARY KEY REFERENCES posts(id) ON DELETE CASCADE,
  user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS post_edit_locks_expiry ON post_edit_locks(expires_at);
