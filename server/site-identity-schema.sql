CREATE TABLE IF NOT EXISTS site_email_changes (
  id integer PRIMARY KEY CHECK(id=1),
  email varchar(254) NOT NULL,
  token_hash char(64) NOT NULL UNIQUE,
  requested_by integer REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
