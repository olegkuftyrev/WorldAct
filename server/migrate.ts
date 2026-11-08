import { readFile } from "node:fs/promises";
import path from "node:path";
import { pool, rootDir } from "./db.js";
import { syncBundledThemes } from "./themes.js";

export async function migrate() {
  const sql = await readFile(
    path.join(rootDir, "server", "schema.sql"),
    "utf8",
  );
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext('worldact-migration'))",
    );
    await client.query(sql);
    // Platform extensions are optional during bootstrap and migrate atomically.
    for (const schema of [
      "platform-schema.sql",
      "comments-schema.sql",
      "accounts-schema.sql",
      "blocks-schema.sql",
      "application-passwords-schema.sql",
      "themes-schema.sql",
      "template-areas-schema.sql",
      "media-schema.sql",
      "edit-locks-schema.sql",
      "site-identity-schema.sql",
      "profile-email-schema.sql",
      "fonts-schema.sql",
      "post-templates-schema.sql",
      "post-trash-schema.sql",
      "bundled-plugins-schema.sql",
      "footnotes-schema.sql",
      "rss-schema.sql",
    ]) {
      const extension = await readFile(
        path.join(rootDir, "server", schema),
        "utf8",
      ).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return "";
        throw error;
      });
      if (extension) await client.query(extension);
    }
    // Earlier canonicalization inserted whitespace into self-closing block delimiters.
    // Repair only Gutenberg comments, preserving surrounding content and attributes.
    for (const table of [
      "posts",
      "post_revisions",
      "post_autosaves",
      "site_documents",
      "block_entities",
    ]) {
      if (
        (await client.query("SELECT to_regclass($1) AS present", [table]))
          .rows[0].present
      )
        await client.query(
          `UPDATE ${table} SET raw_content=regexp_replace(raw_content,'(<!-- wp:[a-zA-Z0-9_/-]+[^<]*?)/ -->','\\1/-->','g') WHERE raw_content LIKE '%/ -->%'`,
        );
    }
    await syncBundledThemes(client);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

if (process.argv[1]?.endsWith("migrate.ts")) {
  try {
    await migrate();
    console.log("WorldAct database migrated.");
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
