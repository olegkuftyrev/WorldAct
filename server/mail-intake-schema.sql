-- Destination-local mailbox credentials and durable idempotence are never in archives.
CREATE TABLE IF NOT EXISTS mail_intake_configuration (
 id integer PRIMARY KEY CHECK(id=1),
 generation uuid NOT NULL DEFAULT gen_random_uuid(),
 host varchar(253) NOT NULL DEFAULT '',
 username varchar(1024) NOT NULL DEFAULT '',
 password varchar(1024) NOT NULL DEFAULT '',
 port integer NOT NULL DEFAULT 110 CHECK(port IN(110,995)),
 secure boolean NOT NULL DEFAULT false,
 enabled boolean NOT NULL DEFAULT false,
 polling boolean NOT NULL DEFAULT false,
 -- A source option may outlive its category. Resolve/fallback at import time;
 -- no category-deletion callback may acquire this mailbox lock after term locks.
 category_id integer CHECK(category_id>0),
 configured_by integer REFERENCES users(id) ON DELETE SET NULL,
 last_checked timestamptz,
 lease_token uuid,
 lease_until timestamptz,
 outcome varchar(40) NOT NULL DEFAULT '',
 summary jsonb NOT NULL DEFAULT '{}'::jsonb,
 cursor_uid_hash char(64) NOT NULL DEFAULT '',
 CHECK(port=CASE WHEN secure THEN 995 ELSE 110 END)
);
INSERT INTO mail_intake_configuration(id) VALUES(1) ON CONFLICT(id) DO NOTHING;
CREATE TABLE IF NOT EXISTS mail_intake_receipts (
 mailbox_hash char(64) NOT NULL,
 uid_hash char(64) NOT NULL,
 post_id integer REFERENCES posts(id) ON DELETE SET NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(mailbox_hash,uid_hash)
);
