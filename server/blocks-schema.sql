ALTER TABLE site_documents ADD COLUMN IF NOT EXISTS raw_content text NOT NULL DEFAULT '';
UPDATE site_documents SET raw_content=content WHERE raw_content='';
CREATE TABLE IF NOT EXISTS block_entities (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind varchar(20) NOT NULL CHECK (kind IN ('reusable','navigation')),
  title varchar(200) NOT NULL,
  slug varchar(220) NOT NULL,
  content text NOT NULL DEFAULT '',
  raw_content text NOT NULL DEFAULT '',
  blocks jsonb NOT NULL DEFAULT '[]'::jsonb,
  status varchar(10) NOT NULL DEFAULT 'publish' CHECK (status IN ('publish','draft','trash')),
  author_id integer NOT NULL REFERENCES users(id),
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(kind,slug)
);
CREATE INDEX IF NOT EXISTS block_entities_kind_status ON block_entities(kind,status,id);
