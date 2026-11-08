-- Backfill only when introducing the column; later user assignments persist.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='site_documents' AND column_name='area') THEN
    ALTER TABLE site_documents ADD COLUMN area varchar(40) NOT NULL DEFAULT 'uncategorized'
      CHECK (area IN ('uncategorized','header','footer','navigation-overlay'));
    UPDATE site_documents SET area=slug WHERE type='template-part' AND slug IN ('header','footer');
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS site_documents_theme_area ON site_documents(theme,area) WHERE type='template-part';
