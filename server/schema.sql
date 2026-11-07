CREATE TABLE IF NOT EXISTS users (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  username varchar(60) NOT NULL,
  email varchar(254) NOT NULL,
  display_name varchar(160) NOT NULL,
  password_hash text NOT NULL,
  role varchar(20) NOT NULL CHECK (role IN ('administrator', 'editor', 'author', 'contributor', 'subscriber')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS users_username_lower ON users (lower(username));
CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower ON users (lower(email));

CREATE TABLE IF NOT EXISTS sessions (
  token_hash char(64) PRIMARY KEY,
  user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions (expires_at);

CREATE TABLE IF NOT EXISTS posts (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  type varchar(8) NOT NULL CHECK (type IN ('post', 'page')),
  title varchar(300) NOT NULL DEFAULT '',
  slug varchar(220) NOT NULL UNIQUE,
  content text NOT NULL DEFAULT '',
  excerpt text NOT NULL DEFAULT '',
  status varchar(10) NOT NULL CHECK (status IN ('publish', 'draft', 'pending', 'future', 'private', 'trash')) DEFAULT 'draft',
  author_id integer NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz
);
CREATE INDEX IF NOT EXISTS posts_type_status ON posts (type, status, created_at DESC);

CREATE TABLE IF NOT EXISTS media (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  author_id integer NOT NULL REFERENCES users(id),
  title varchar(300) NOT NULL,
  filename varchar(100) NOT NULL UNIQUE,
  mime_type varchar(40) NOT NULL,
  alt varchar(1000) NOT NULL DEFAULT '',
  caption text NOT NULL DEFAULT '',
  size integer NOT NULL CHECK (size > 0),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS comments (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  post_id integer NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  author_name varchar(160) NOT NULL,
  author_email varchar(254) NOT NULL,
  content text NOT NULL,
  status varchar(10) NOT NULL CHECK (status IN ('approved', 'pending', 'spam', 'trash')) DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS comments_status_date ON comments (status, created_at DESC);
CREATE TABLE IF NOT EXISTS settings (
  id integer PRIMARY KEY CHECK (id = 1),
  data jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE TABLE IF NOT EXISTS seed_markers (
  name text PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Additive, repeatable upgrades preserve content created by earlier WorldAct versions.
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('administrator', 'editor', 'author', 'contributor', 'subscriber'));
ALTER TABLE posts DROP CONSTRAINT IF EXISTS posts_status_check;
ALTER TABLE posts ADD CONSTRAINT posts_status_check CHECK (status IN ('publish', 'draft', 'pending', 'future', 'private', 'trash'));
ALTER TABLE posts ADD COLUMN IF NOT EXISTS blocks jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE posts ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1;
ALTER TABLE posts ADD COLUMN IF NOT EXISTS scheduled_at timestamptz;
ALTER TABLE posts ADD COLUMN IF NOT EXISTS parent_id integer REFERENCES posts(id) ON DELETE SET NULL;
ALTER TABLE posts ADD COLUMN IF NOT EXISTS menu_order integer NOT NULL DEFAULT 0;
ALTER TABLE posts ADD COLUMN IF NOT EXISTS featured_media_id integer REFERENCES media(id) ON DELETE SET NULL;
ALTER TABLE posts ADD COLUMN IF NOT EXISTS comment_status varchar(8) NOT NULL DEFAULT 'open' CHECK (comment_status IN ('open', 'closed'));
ALTER TABLE posts ADD COLUMN IF NOT EXISTS sticky boolean NOT NULL DEFAULT false;
ALTER TABLE posts ADD COLUMN IF NOT EXISTS password_hash text;
CREATE INDEX IF NOT EXISTS posts_scheduled ON posts (scheduled_at) WHERE status = 'future';
CREATE INDEX IF NOT EXISTS posts_parent ON posts (parent_id);

CREATE TABLE IF NOT EXISTS terms (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  taxonomy varchar(8) NOT NULL CHECK (taxonomy IN ('category', 'tag')),
  name varchar(200) NOT NULL,
  slug varchar(220) NOT NULL,
  description text NOT NULL DEFAULT '',
  parent_id integer REFERENCES terms(id) ON DELETE SET NULL,
  is_default boolean NOT NULL DEFAULT false,
  UNIQUE (taxonomy, slug),
  CHECK (taxonomy = 'category' OR parent_id IS NULL),
  CHECK (parent_id IS NULL OR parent_id <> id)
);
CREATE UNIQUE INDEX IF NOT EXISTS terms_default_category ON terms (taxonomy) WHERE is_default;
INSERT INTO terms (taxonomy, name, slug, is_default) SELECT 'category', 'Uncategorized', 'uncategorized', true WHERE NOT EXISTS (SELECT 1 FROM terms WHERE is_default)
ON CONFLICT (taxonomy, slug) DO UPDATE SET is_default = true;
CREATE TABLE IF NOT EXISTS post_terms (
  post_id integer NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  term_id integer NOT NULL REFERENCES terms(id) ON DELETE CASCADE,
  PRIMARY KEY (post_id, term_id)
);
CREATE INDEX IF NOT EXISTS post_terms_term ON post_terms (term_id, post_id);
INSERT INTO post_terms (post_id, term_id)
SELECT p.id, t.id FROM posts p CROSS JOIN terms t WHERE p.type = 'post' AND t.is_default
AND NOT EXISTS (SELECT 1 FROM post_terms pt JOIN terms assigned ON assigned.id = pt.term_id WHERE pt.post_id = p.id AND assigned.taxonomy = 'category')
ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS post_revisions (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  post_id integer NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  author_id integer REFERENCES users(id) ON DELETE SET NULL,
  title varchar(300) NOT NULL,
  content text NOT NULL,
  excerpt text NOT NULL,
  blocks jsonb NOT NULL DEFAULT '[]'::jsonb,
  slug varchar(220) NOT NULL,
  status varchar(10) NOT NULL,
  version integer NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS post_revisions_post ON post_revisions (post_id, id DESC);
CREATE TABLE IF NOT EXISTS post_autosaves (
  post_id integer NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title varchar(300) NOT NULL,
  content text NOT NULL,
  excerpt text NOT NULL,
  blocks jsonb NOT NULL DEFAULT '[]'::jsonb,
  version integer NOT NULL,
  saved_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (post_id, user_id)
);
CREATE TABLE IF NOT EXISTS post_access_tokens (
  token_hash char(64) PRIMARY KEY,
  post_id integer NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  password_hash text NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS post_access_tokens_expiry ON post_access_tokens (expires_at);

ALTER TABLE comments ADD COLUMN IF NOT EXISTS parent_id integer REFERENCES comments(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS comments_parent ON comments (parent_id);

ALTER TABLE posts ADD COLUMN IF NOT EXISTS raw_content text NOT NULL DEFAULT '';
ALTER TABLE post_revisions ADD COLUMN IF NOT EXISTS raw_content text NOT NULL DEFAULT '';
ALTER TABLE post_autosaves ADD COLUMN IF NOT EXISTS raw_content text NOT NULL DEFAULT '';
ALTER TABLE posts ADD COLUMN IF NOT EXISTS format varchar(20) NOT NULL DEFAULT 'standard'
  CHECK (format IN ('standard','aside','image','video','quote','link','gallery','audio'));
