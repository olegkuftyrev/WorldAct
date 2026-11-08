CREATE TABLE IF NOT EXISTS application_passwords (
  uuid uuid PRIMARY KEY,
  user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  app_id uuid,
  name varchar(200) NOT NULL,
  key_hash char(64) NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used timestamptz,
  last_ip varchar(100)
);
CREATE INDEX IF NOT EXISTS application_passwords_user ON application_passwords(user_id,created_at);
CREATE UNIQUE INDEX IF NOT EXISTS application_passwords_name ON application_passwords(user_id,lower(name));
