// Only the fixed upload-original sentinel is exposed. Imported paths are
// generated afresh by SiteImport; arbitrary derivative keys remain private.
const originalPath = String.raw`(?:[0-9]{4}/[0-9]{2}/|imports/[a-f0-9]{16}/)?[a-f0-9]{32,40}\.(?:jpg|jpeg|png|gif|webp|avif)`;
export const ORIGINAL_UPLOAD_URL_SQL = `CASE WHEN mime_type LIKE 'image/%' AND jsonb_typeof(derivatives->'original-upload')='string' AND (derivatives->>'original-upload') ~ '^${originalPath}$' THEN '/uploads/' || (derivatives->>'original-upload') ELSE NULL END`;
