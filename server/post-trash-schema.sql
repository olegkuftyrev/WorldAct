ALTER TABLE posts ADD COLUMN IF NOT EXISTS pre_trash_status varchar(12)
  CHECK (pre_trash_status IN ('publish','future','private','draft','pending'));

-- Earlier versions retained revision snapshots before entering Trash. Recover
-- that status once, preserving explicit metadata on every repeated migration.
UPDATE posts p SET pre_trash_status=(
  SELECT r.status FROM post_revisions r
  WHERE r.post_id=p.id AND r.status IN ('publish','future','private','draft','pending')
  ORDER BY r.id DESC LIMIT 1
)
WHERE p.status='trash' AND p.pre_trash_status IS NULL;
