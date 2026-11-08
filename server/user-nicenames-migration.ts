import type { PoolClient } from "pg";
import { defaultUserNicename, validUserNicename, userNicenameCandidate } from "./user-nicenames.js";

/** Caller holds the migration lock, creation barrier and users ACCESS EXCLUSIVE.
 * Assigned identities are never repaired or renamed by repeated migrations. */
export async function migrateUserNicenames(db: PoolClient) {
  await db.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS nicename varchar(50)");
  const rows = (await db.query("SELECT id,username,nicename FROM users ORDER BY id")).rows;
  const reserved = new Set<string>();
  for (const row of rows) {
    if (row.nicename === null) continue;
    if (!validUserNicename(row.nicename) || reserved.has(row.nicename))
      throw new Error("Invalid or duplicate assigned public author identity; migration was rolled back.");
    reserved.add(row.nicename);
  }
  for (const row of rows) {
    if (row.nicename !== null) continue;
    const source = defaultUserNicename(row.username);
    // Manually inserted legacy logins outside the supported ASCII creation
    // contract retain their spelling; do not invent a transliteration claim.
    const base = /^[a-zA-Z0-9_.@-]+$/.test(row.username) && validUserNicename(source) ? source : `user-${row.id}`;
    let suffix = 1, candidate = base;
    while (reserved.has(candidate)) candidate = userNicenameCandidate(base, ++suffix);
    reserved.add(candidate);
    await db.query("UPDATE users SET nicename=$1 WHERE id=$2 AND nicename IS NULL", [candidate, row.id]);
  }
  // PostgreSQL rejects overlength assignment here; there is no truncating cast.
  // This also tightens a legacy nullable TEXT column after validating its data.
  await db.query("ALTER TABLE users ALTER COLUMN nicename TYPE varchar(50)");
  await db.query("ALTER TABLE users ALTER COLUMN nicename SET NOT NULL");
  await db.query(`DO $$ BEGIN
    IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='users'::regclass AND conname='users_nicename_shape') THEN
      ALTER TABLE users ADD CONSTRAINT users_nicename_shape CHECK(nicename ~ '^[a-z0-9_-]+$' AND nicename <> '0');
    END IF;
  END $$`);
  await db.query("CREATE UNIQUE INDEX IF NOT EXISTS users_nicename_unique ON users(nicename)");
}
