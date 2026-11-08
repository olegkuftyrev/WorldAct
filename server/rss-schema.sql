CREATE TABLE IF NOT EXISTS rss_feed_cache (
  cache_key char(64) PRIMARY KEY CHECK (cache_key ~ '^[a-f0-9]{64}$'),
  url varchar(2048) NOT NULL,
  data jsonb,
  error varchar(300) NOT NULL DEFAULT '',
  bytes integer NOT NULL DEFAULT 0 CHECK (bytes BETWEEN 0 AND 262144),
  fetched_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  CHECK (data IS NULL OR jsonb_typeof(data)='object')
);
CREATE INDEX IF NOT EXISTS rss_feed_cache_expiry ON rss_feed_cache(expires_at);
