ALTER TABLE posts ADD COLUMN IF NOT EXISTS footnotes jsonb NOT NULL DEFAULT '[]'::jsonb
  CHECK (jsonb_typeof(footnotes)='array' AND jsonb_array_length(footnotes)<=500);
ALTER TABLE post_autosaves ADD COLUMN IF NOT EXISTS footnotes jsonb NOT NULL DEFAULT '[]'::jsonb
  CHECK (jsonb_typeof(footnotes)='array' AND jsonb_array_length(footnotes)<=500);
