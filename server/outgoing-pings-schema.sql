-- Source publication marks become durable, lease-owned Node work; no network in transactions.
CREATE TABLE IF NOT EXISTS outgoing_ping_jobs (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 dedupe_key varchar(120) NOT NULL UNIQUE,
 kind varchar(12) NOT NULL CHECK(kind IN ('discover','pingback','service')),
 post_id integer REFERENCES posts(id) ON DELETE CASCADE,
 target text NOT NULL DEFAULT '',
 generation integer NOT NULL DEFAULT 1,
 state varchar(12) NOT NULL CHECK(state IN ('pending','running','sent','failed','suppressed')),
 outcome varchar(40) NOT NULL DEFAULT '',
 attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 3),
 due_at timestamptz NOT NULL DEFAULT now(),
 lease_token uuid,
 lease_until timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS outgoing_ping_due ON outgoing_ping_jobs(due_at,id) WHERE state IN ('pending','running');
CREATE TABLE IF NOT EXISTS outgoing_ping_sent (
 post_id integer NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
 target_hash char(64) NOT NULL,
 sent_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(post_id,target_hash)
);
