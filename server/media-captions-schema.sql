-- Prior WorldAct caption writes were plaintext. Escape those records exactly
-- once so tag-shaped text/entities remain literal when the native editor reads
-- caption.raw as HTML. A marker is also exported with each JSON media record.
ALTER TABLE media ADD COLUMN IF NOT EXISTS caption_is_html boolean NOT NULL DEFAULT false;
UPDATE media SET caption=replace(replace(replace(caption,'&','&amp;'),'<','&lt;'),'>','&gt;'),caption_is_html=true WHERE NOT caption_is_html;
ALTER TABLE media ALTER COLUMN caption_is_html SET DEFAULT true;
