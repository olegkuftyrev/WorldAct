import type { PoolClient } from "pg";
import { pool } from "./db.js";

/** Read-only existing durable readiness contract; never initializes on GET. */
export async function isInstalled(db: Pick<PoolClient,"query"> = pool) {
  return Boolean((await db.query("SELECT EXISTS(SELECT 1 FROM users) OR EXISTS(SELECT 1 FROM seed_markers WHERE name IN('initial-content-v1','browser-install-v1')) OR EXISTS(SELECT 1 FROM posts) OR EXISTS(SELECT 1 FROM media) AS installed")).rows[0].installed);
}
