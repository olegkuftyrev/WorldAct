import type {PoolClient} from "pg";
import {getSettings} from "./db.js";
import {dateArchiveLocalSQL} from "./date-archives.js";
import {POST_DATE_SQL} from "./post-date.js";
/** Called inside the existing users-first, quiesced migration transaction. */
export async function migratePostDates(db:PoolClient){
 await db.query(`ALTER TABLE posts ADD COLUMN IF NOT EXISTS post_date text;
 ALTER TABLE posts ADD COLUMN IF NOT EXISTS post_date_gmt timestamptz;
 CREATE OR REPLACE FUNCTION worldact_valid_post_civil(value text) RETURNS boolean LANGUAGE plpgsql IMMUTABLE STRICT AS $$
 BEGIN
  IF value !~ '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]$' OR substring(value,1,4)='0000' THEN RETURN false; END IF;
  RETURN to_char(value::timestamp without time zone,'YYYY-MM-DD"T"HH24:MI:SS')=value;
 EXCEPTION WHEN OTHERS THEN RETURN false;
 END $$;`);
 const settings=await getSettings(db),args:unknown[]=[],local=dateArchiveLocalSQL(POST_DATE_SQL,args,settings.timezone);
 const bad=(await db.query(`SELECT p.id FROM posts p WHERE
 (p.post_date IS NULL AND p.post_date_gmt IS NOT NULL) OR
 (p.post_date IS NOT NULL AND NOT worldact_valid_post_civil(p.post_date)) OR
 (p.post_date_gmt IS NOT NULL AND NOT (p.post_date_gmt>='0001-01-01T00:00:00Z'::timestamptz AND p.post_date_gmt<'10000-01-01T00:00:00Z'::timestamptz)) OR
 (p.post_date IS NULL AND (NOT (${POST_DATE_SQL}>='0001-01-01T00:00:00Z'::timestamptz AND ${POST_DATE_SQL}<'10000-01-01T00:00:00Z'::timestamptz) OR extract(year FROM ${local}) NOT BETWEEN 1 AND 9999 OR NOT worldact_valid_post_civil(to_char(${local},'YYYY-MM-DD"T"HH24:MI:SS'))))
 ORDER BY p.id LIMIT 10`,args)).rows;
 if(bad.length)throw new Error("Publication date migration rejected unsupported or invalid selected pairs for post IDs: "+bad.map(row=>row.id).join(", "));
 await db.query(`UPDATE posts p SET post_date=to_char(${local},'YYYY-MM-DD"T"HH24:MI:SS'),post_date_gmt=CASE WHEN
 COALESCE(CASE WHEN p.status='trash' THEN p.pre_trash_status ELSE p.status END,'draft') IN ('draft','pending') AND p.published_at IS NULL AND p.scheduled_at IS NULL THEN NULL ELSE ${POST_DATE_SQL} END
 WHERE p.post_date IS NULL AND p.post_date_gmt IS NULL`,args);
 await db.query(`ALTER TABLE posts ALTER COLUMN post_date SET NOT NULL;
 ALTER TABLE posts DROP CONSTRAINT IF EXISTS posts_civil_date_valid;
 ALTER TABLE posts ADD CONSTRAINT posts_civil_date_valid CHECK(worldact_valid_post_civil(post_date));
 ALTER TABLE posts DROP CONSTRAINT IF EXISTS posts_selected_gmt_valid;
 ALTER TABLE posts ADD CONSTRAINT posts_selected_gmt_valid CHECK(post_date_gmt IS NULL OR (post_date_gmt>='0001-01-01T00:00:00Z'::timestamptz AND post_date_gmt<'10000-01-01T00:00:00Z'::timestamptz));`);
}
