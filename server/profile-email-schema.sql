CREATE TABLE IF NOT EXISTS user_email_changes (
  user_id integer PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  email varchar(254) NOT NULL,
  previous_email varchar(254) NOT NULL,
  token_hash char(64) NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
