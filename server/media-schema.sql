ALTER TABLE media ADD COLUMN IF NOT EXISTS attached_post_id integer REFERENCES posts(id) ON DELETE SET NULL;
ALTER TABLE media ADD COLUMN IF NOT EXISTS description text NOT NULL DEFAULT '';
ALTER TABLE media ADD COLUMN IF NOT EXISTS comment_status varchar(6) NOT NULL DEFAULT 'closed' CHECK(comment_status IN ('open','closed'));
CREATE INDEX IF NOT EXISTS media_attachment ON media(attached_post_id);
CREATE INDEX IF NOT EXISTS media_created ON media(created_at DESC,id DESC);
