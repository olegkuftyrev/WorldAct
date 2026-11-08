-- Block themes are content scoped by theme; switching themes preserves edits.
ALTER TABLE site_documents ADD COLUMN IF NOT EXISTS theme varchar(40) NOT NULL DEFAULT 'twentytwentyfive';
ALTER TABLE site_documents ADD COLUMN IF NOT EXISTS source_hash varchar(64);
ALTER TABLE site_documents ADD COLUMN IF NOT EXISTS source_content text;
ALTER TABLE site_documents ADD COLUMN IF NOT EXISTS source_metadata jsonb NOT NULL DEFAULT '{}'::jsonb;
DO $$
DECLARE item record;
BEGIN
  -- Remove the earlier global slug constraint. Constraint names can differ on imports.
  FOR item IN SELECT conname FROM pg_constraint WHERE conrelid='site_documents'::regclass
    AND contype='u' AND pg_get_constraintdef(oid)='UNIQUE (type, slug)'
  LOOP EXECUTE format('ALTER TABLE site_documents DROP CONSTRAINT %I',item.conname); END LOOP;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS site_documents_theme_type_slug ON site_documents(theme,type,slug);
CREATE INDEX IF NOT EXISTS site_documents_theme_type ON site_documents(theme,type);
CREATE TABLE IF NOT EXISTS theme_designs (
  theme varchar(40) PRIMARY KEY,
  variation varchar(120) NOT NULL DEFAULT '',
  styles jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO theme_designs(theme) VALUES('twentytwentyfive'),('twentytwentyfour'),('twentytwentythree'),('classic') ON CONFLICT DO NOTHING;
