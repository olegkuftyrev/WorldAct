CREATE TABLE IF NOT EXISTS font_families (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name varchar(120) NOT NULL,
  slug varchar(160) NOT NULL UNIQUE,
  source varchar(12) NOT NULL CHECK(source IN ('upload','bundled')),
  collection_key varchar(160),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS font_families_name_lower ON font_families(lower(name));
CREATE TABLE IF NOT EXISTS font_faces (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  family_id integer NOT NULL REFERENCES font_families(id) ON DELETE CASCADE,
  filename varchar(255),
  url text NOT NULL,
  format varchar(8) NOT NULL CHECK(format IN ('truetype','opentype','woff','woff2')),
  style varchar(12) NOT NULL DEFAULT 'normal' CHECK(style IN ('normal','italic','oblique')),
  weight varchar(20) NOT NULL DEFAULT '400',
  stretch varchar(30) NOT NULL DEFAULT 'normal',
  sha256 char(64) NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE font_faces DROP CONSTRAINT IF EXISTS font_faces_sha256_key;
CREATE UNIQUE INDEX IF NOT EXISTS font_faces_family_sha256 ON font_faces(family_id,sha256);
CREATE INDEX IF NOT EXISTS font_faces_family ON font_faces(family_id,id);
CREATE TABLE IF NOT EXISTS theme_fonts (
  theme varchar(40) NOT NULL,
  family_id integer NOT NULL REFERENCES font_families(id) ON DELETE CASCADE,
  PRIMARY KEY(theme,family_id)
);
