CREATE TABLE IF NOT EXISTS users (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  username varchar(60) NOT NULL,
  email varchar(254) NOT NULL,
  display_name varchar(160) NOT NULL,
  password_hash text NOT NULL,
  role varchar(20) NOT NULL CHECK (role IN ('administrator', 'editor', 'author', 'subscriber')),
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
  status varchar(10) NOT NULL CHECK (status IN ('publish', 'draft', 'trash')) DEFAULT 'draft',
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
