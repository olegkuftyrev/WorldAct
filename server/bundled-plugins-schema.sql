CREATE TABLE IF NOT EXISTS extension_secrets (
  slug varchar(100) PRIMARY KEY REFERENCES extensions(slug) ON DELETE CASCADE,
  api_key varchar(128) NOT NULL,
  verified_site_url text,
  verified_at timestamptz,
  last_error_code varchar(40),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS akismet_comment_checks (
  comment_id integer PRIMARY KEY REFERENCES comments(id) ON DELETE CASCADE,
  user_ip varchar(64) NOT NULL,
  user_agent varchar(1024) NOT NULL DEFAULT '',
  referrer varchar(2000) NOT NULL DEFAULT '',
  verdict varchar(16) NOT NULL CHECK(verdict IN ('spam','ham','unavailable')),
  checked_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now()+interval '30 days',
  feedback varchar(16) CHECK(feedback IN ('spam','ham')),
  feedback_status varchar(16) CHECK(feedback_status IN ('sent','unavailable'))
);
CREATE INDEX IF NOT EXISTS akismet_comment_checks_expiry ON akismet_comment_checks(expires_at);
-- Credentials from older experimental/imported extension data must not remain
-- in a generally exported settings column. Only the dedicated config API sets keys.
UPDATE extensions SET settings=settings-'apiKey'-'api_key'-'key'-'clearApiKey' WHERE slug='akismet';
