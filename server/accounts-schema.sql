CREATE TABLE IF NOT EXISTS privacy_requests (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email varchar(254) NOT NULL,
  type varchar(8) NOT NULL CHECK (type IN ('export','erase')),
  status varchar(12) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','confirmed','completed','failed')),
  requested_by integer REFERENCES users(id) ON DELETE SET NULL,
  confirmation_token_hash char(64),
  confirmation_expires_at timestamptz,
  confirmed_at timestamptz,
  completed_at timestamptz,
  download_token_hash char(64),
  download_expires_at timestamptz,
  export_data jsonb,
  result jsonb,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS privacy_requests_confirmation_token ON privacy_requests(confirmation_token_hash) WHERE confirmation_token_hash IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS privacy_requests_download_token ON privacy_requests(download_token_hash) WHERE download_token_hash IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS privacy_requests_active_email_type ON privacy_requests(lower(email),type) WHERE status IN ('pending','confirmed','failed');
CREATE INDEX IF NOT EXISTS privacy_requests_type_status_date ON privacy_requests(type,status,created_at DESC);
UPDATE settings SET data='{"usersCanRegister":false,"defaultRole":"subscriber"}'::jsonb || data WHERE id=1;
