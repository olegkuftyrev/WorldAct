ALTER TABLE media ADD COLUMN IF NOT EXISTS attached_post_id integer REFERENCES posts(id) ON DELETE SET NULL;
ALTER TABLE media ADD COLUMN IF NOT EXISTS description text NOT NULL DEFAULT '';
ALTER TABLE media ADD COLUMN IF NOT EXISTS comment_status varchar(6) NOT NULL DEFAULT 'closed' CHECK(comment_status IN ('open','closed'));
CREATE INDEX IF NOT EXISTS media_attachment ON media(attached_post_id);
CREATE INDEX IF NOT EXISTS media_created ON media(created_at DESC,id DESC);
ALTER TABLE media ADD COLUMN IF NOT EXISTS audio_metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK(jsonb_typeof(audio_metadata)='object');
ALTER TABLE media ADD COLUMN IF NOT EXISTS artwork_media_id integer REFERENCES media(id) ON DELETE SET NULL;
ALTER TABLE media ADD COLUMN IF NOT EXISTS cover_hash char(64) CHECK(cover_hash ~ '^[a-f0-9]{64}$');
CREATE INDEX IF NOT EXISTS media_cover_hash ON media(author_id,cover_hash) WHERE cover_hash IS NOT NULL;
