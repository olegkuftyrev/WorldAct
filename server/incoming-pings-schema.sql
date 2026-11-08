ALTER TABLE comments ADD COLUMN IF NOT EXISTS type varchar(10) NOT NULL DEFAULT 'comment' CHECK(type IN('comment','pingback','trackback'));
ALTER TABLE comments ADD COLUMN IF NOT EXISTS source_hash char(64);
-- URL keys stay bounded; every write path, including moderator edits/imports,
-- receives the same identity fence. Existing human comments remain untouched.
CREATE OR REPLACE FUNCTION worldact_comment_source_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.type='comment' THEN NEW.source_hash=NULL;
  ELSE
    NEW.author_email=''; NEW.user_id=NULL;
    NEW.source_hash=encode(sha256(convert_to(NEW.author_url,'UTF8')),'hex');
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS worldact_comment_source_identity ON comments;
CREATE TRIGGER worldact_comment_source_identity BEFORE INSERT OR UPDATE OF type,author_url,author_email,user_id ON comments FOR EACH ROW EXECUTE FUNCTION worldact_comment_source_identity();
CREATE UNIQUE INDEX IF NOT EXISTS comments_ping_source ON comments(post_id,source_hash) WHERE type<>'comment';
CREATE INDEX IF NOT EXISTS comments_post_type_status ON comments(post_id,type,status);
CREATE TABLE IF NOT EXISTS incoming_ping_rates(key char(64) PRIMARY KEY,window_start timestamptz NOT NULL,count integer NOT NULL CHECK(count>0));
CREATE TABLE IF NOT EXISTS incoming_ping_leases(token uuid PRIMARY KEY,expires_at timestamptz NOT NULL);
