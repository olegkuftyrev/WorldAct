import { readFile } from "node:fs/promises";
import path from "node:path";
import { pool, rootDir } from "./db.js";

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
    const platformSql = await readFile(path.join(rootDir, "server", "platform-schema.sql"), "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return "";
      throw error;
    });
    if (platformSql) await client.query(platformSql);
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
